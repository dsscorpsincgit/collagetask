import { useEffect, useRef, useState } from 'react';
import { Copy, Hand, Maximize, MessageCircle, Mic, MonitorUp, PhoneCall, Send, UsersRound, Video, X } from 'lucide-react';
import { api, realtime } from './realtime';

const initials=name=>String(name||'').split(' ').map(part=>part[0]).join('').slice(0,2).toUpperCase();

function ParticipantAvatar({person,size=34}) {
  return <span className="avatar" style={{width:size,height:size,background:person.avatar_color||person.avatarColor||'#2c5de5'}}>{initials(person.name)}</span>;
}

function ParticipantVideo({participant}) {
  const video=useRef(null);
  useEffect(()=>{if(video.current)video.current.srcObject=participant.stream||null},[participant.stream]);
  const showingVideo=Boolean(participant.stream&&participant.camera!==false&&participant.stream.getVideoTracks().length);
  return <div className="video-tile remote">
    <video ref={video} autoPlay playsInline/>
    <div className={`camera-placeholder ${showingVideo?'hidden':''}`}><ParticipantAvatar person={participant} size={72}/><strong>{participant.camera===false?'Camera is off':participant.stream?'Connecting video...':'Connecting...'}</strong></div>
    <span>{participant.name}</span>
  </div>;
}

export default function EnhancedMeetingRoom({meeting,user,users=[],onClose}) {
  const localVideo=useRef(null),streamRef=useRef(null),peers=useRef(new Map()),pendingIce=useRef(new Map());
  const[remotes,setRemotes]=useState([]),[roomPeople,setRoomPeople]=useState([]),[mediaStates,setMediaStates]=useState({});
  const[mic,setMic]=useState(true),[camera,setCamera]=useState(meeting.meeting_mode!=='voice'),[sharing,setSharing]=useState(false),[ready,setReady]=useState(false);
  const[error,setError]=useState(''),[mediaWarning,setMediaWarning]=useState(''),[panel,setPanel]=useState(null),[seconds,setSeconds]=useState(0);
  const[chatMessages,setChatMessages]=useState([]),[chatText,setChatText]=useState(''),[raised,setRaised]=useState(false),[raisedHands,setRaisedHands]=useState({});

  useEffect(()=>{const timer=setInterval(()=>setSeconds(value=>value+1),1000);return()=>clearInterval(timer)},[]);

  useEffect(()=>{
    let active=true,detachRealtime=()=>{},joinedOnce=false;
    const setup=async()=>{
      try {
        const config=await api('/webrtc-config');
        let stream;
        try {stream=await navigator.mediaDevices.getUserMedia({video:meeting.meeting_mode!=='voice',audio:true})}
        catch(mediaError){stream=new MediaStream();setMediaWarning(mediaError.name==='NotAllowedError'?'Camera and microphone are blocked. Allow browser access to share them.':'No camera or microphone is available on this device.')}
        if(!active){stream.getTracks().forEach(track=>track.stop());return}
        streamRef.current=stream;
        if(localVideo.current)localVideo.current.srcObject=stream;
        const initialMic=Boolean(stream.getAudioTracks()[0]?.enabled),initialCamera=Boolean(stream.getVideoTracks()[0]?.enabled);
        setMic(initialMic);setCamera(initialCamera);setReady(true);
        api('/users/me/status',{method:'PATCH',body:JSON.stringify({work_status:'in_meeting'})}).catch(()=>{});

        const addRemote=(id,remoteStream)=>setRemotes(current=>[...current.filter(person=>person.id!==id),{id,stream:remoteStream}]);
        const getPeer=id=>{
          if(peers.current.has(id))return peers.current.get(id);
          const peer=new RTCPeerConnection(config);
          stream.getTracks().forEach(track=>peer.addTrack(track,stream));
          if(!stream.getAudioTracks().length)peer.addTransceiver('audio',{direction:'recvonly'});
          if(meeting.meeting_mode!=='voice'&&!stream.getVideoTracks().length)peer.addTransceiver('video',{direction:'recvonly'});
          peer.onicecandidate=event=>event.candidate&&realtime.emit('webrtc-ice',{target:id,candidate:event.candidate});
          peer.ontrack=event=>addRemote(id,event.streams[0]||new MediaStream([event.track]));
          peer.onconnectionstatechange=()=>{if(['failed','closed','disconnected'].includes(peer.connectionState))setRemotes(current=>current.filter(person=>person.id!==id))};
          peers.current.set(id,peer);
          return peer;
        };
        const queueIce=(id,candidate)=>pendingIce.current.set(id,[...(pendingIce.current.get(id)||[]),candidate]);
        const flushIce=async(id,peer)=>{const queued=pendingIce.current.get(id)||[];pendingIce.current.delete(id);for(const candidate of queued)try{await peer.addIceCandidate(candidate)}catch{/* A reconnect can invalidate an old candidate. */}};
        const receiveParticipants=async list=>{
          setRoomPeople(list);
          setMediaStates(Object.fromEntries(list.map(person=>[person.id,person.media||{mic:false,camera:false}])));
          for(const person of list)try{const peer=getPeer(person.id),offer=await peer.createOffer();await peer.setLocalDescription(offer);realtime.emit('webrtc-offer',{target:person.id,offer})}catch(connectionError){console.warn('Unable to offer meeting connection:',connectionError.message)}
        };
        const receiveOffer=async({from,offer})=>{try{const peer=getPeer(from);await peer.setRemoteDescription(offer);await flushIce(from,peer);const answer=await peer.createAnswer();await peer.setLocalDescription(answer);realtime.emit('webrtc-answer',{target:from,answer})}catch(connectionError){console.warn('Unable to answer meeting connection:',connectionError.message)}};
        const receiveAnswer=async({from,answer})=>{try{const peer=peers.current.get(from);if(peer){await peer.setRemoteDescription(answer);await flushIce(from,peer)}}catch(connectionError){console.warn('Unable to complete meeting connection:',connectionError.message)}};
        const receiveIce=async({from,candidate})=>{const peer=peers.current.get(from);if(!peer||!peer.remoteDescription){queueIce(from,candidate);return}try{await peer.addIceCandidate(candidate)}catch{/* Another candidate may still connect. */}};
        const receiveJoined=person=>{setRoomPeople(current=>[...current.filter(item=>item.id!==person.id),person]);setMediaStates(current=>({...current,[person.id]:person.media||{mic:false,camera:false}}))};
        const receiveLeft=({id})=>{peers.current.get(id)?.close();peers.current.delete(id);pendingIce.current.delete(id);setRemotes(current=>current.filter(person=>person.id!==id));setRoomPeople(current=>current.filter(person=>person.id!==id));setMediaStates(current=>{const next={...current};delete next[id];return next});setRaisedHands(current=>{const next={...current};delete next[id];return next})};
        const receiveChat=item=>setChatMessages(current=>[...current,item]);
        const receiveHand=item=>setRaisedHands(current=>({...current,[item.socketId]:item.raised?item.userName:undefined}));
        const receiveMedia=item=>setMediaStates(current=>({...current,[item.socketId]:{mic:item.mic,camera:item.camera}}));
        const joinRoom=()=>{
          if(joinedOnce){peers.current.forEach(peer=>peer.close());peers.current.clear();pendingIce.current.clear();setRemotes([]);setRoomPeople([])}
          joinedOnce=true;
          realtime.emit('join-meeting',{roomName:meeting.room_name,media:{mic:Boolean(stream.getAudioTracks()[0]?.enabled),camera:Boolean(stream.getVideoTracks()[0]?.enabled)}});
        };

        realtime.on('meeting-participants',receiveParticipants);realtime.on('webrtc-offer',receiveOffer);realtime.on('webrtc-answer',receiveAnswer);realtime.on('webrtc-ice',receiveIce);
        realtime.on('participant-joined',receiveJoined);realtime.on('participant-left',receiveLeft);realtime.on('meeting-chat',receiveChat);realtime.on('meeting-hand',receiveHand);realtime.on('meeting-media-state',receiveMedia);realtime.on('connect',joinRoom);
        if(realtime.connected)joinRoom();
        detachRealtime=()=>{realtime.off('meeting-participants',receiveParticipants);realtime.off('webrtc-offer',receiveOffer);realtime.off('webrtc-answer',receiveAnswer);realtime.off('webrtc-ice',receiveIce);realtime.off('participant-joined',receiveJoined);realtime.off('participant-left',receiveLeft);realtime.off('meeting-chat',receiveChat);realtime.off('meeting-hand',receiveHand);realtime.off('meeting-media-state',receiveMedia);realtime.off('connect',joinRoom)};
      } catch(setupError) {setError(setupError.message||'Unable to connect to the meeting')}
    };
    setup();
    return()=>{active=false;realtime.emit('leave-meeting',{roomName:meeting.room_name});detachRealtime();streamRef.current?.getTracks().forEach(track=>track.stop());peers.current.forEach(peer=>peer.close());peers.current.clear();pendingIce.current.clear();api('/users/me/status',{method:'PATCH',body:JSON.stringify({work_status:'available'})}).catch(()=>{})};
  },[meeting.room_name,meeting.meeting_mode]);

  const emitMedia=(nextMic,nextCamera)=>realtime.emit('meeting-media-state',{roomName:meeting.room_name,mic:nextMic,camera:nextCamera});
  const toggleTrack=kind=>{const track=streamRef.current?.getTracks().find(item=>item.kind===kind);if(!track)return;track.enabled=!track.enabled;if(kind==='audio'){setMic(track.enabled);emitMedia(track.enabled,camera)}else{setCamera(track.enabled);emitMedia(mic,track.enabled)}};
  const share=async()=>{if(sharing)return;try{const display=await navigator.mediaDevices.getDisplayMedia({video:true}),track=display.getVideoTracks()[0];peers.current.forEach(peer=>peer.getSenders().find(sender=>sender.track?.kind==='video')?.replaceTrack(track));if(localVideo.current)localVideo.current.srcObject=display;setSharing(true);track.onended=()=>{const cameraTrack=streamRef.current?.getVideoTracks()[0];peers.current.forEach(peer=>peer.getSenders().find(sender=>sender.track?.kind==='video')?.replaceTrack(cameraTrack));if(localVideo.current)localVideo.current.srcObject=streamRef.current;setSharing(false)}}catch{/* Screen sharing was cancelled. */}};
  const toggleHand=()=>{const next=!raised;setRaised(next);realtime.emit('meeting-hand',{roomName:meeting.room_name,raised:next})};
  const sendChat=event=>{event.preventDefault();if(!chatText.trim())return;realtime.emit('meeting-chat',{roomName:meeting.room_name,message:chatText});setChatText('')};
  const copyInvite=async()=>{const url=new URL(location.href);url.searchParams.set('meeting',meeting.room_name);await navigator.clipboard.writeText(url.toString())};
  const toggleFullscreen=()=>document.fullscreenElement?document.exitFullscreen():document.querySelector('.meeting-room-overlay')?.requestFullscreen();
  const elapsed=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;

  const connectedUserIds=new Set([Number(user.id),...roomPeople.map(person=>Number(person.userId)).filter(Boolean)]);
  const attendeeIds=new Set((meeting.attendee_ids||[]).map(Number));attendeeIds.add(Number(user.id));
  const invited=users.filter(person=>attendeeIds.has(Number(person.id)));
  if(!invited.some(person=>Number(person.id)===Number(user.id)))invited.unshift(user);
  const extraJoined=roomPeople.filter(person=>!invited.some(invitee=>Number(invitee.id)===Number(person.userId)));
  const roster=[
    ...invited.map(person=>{const connection=roomPeople.find(item=>Number(item.userId)===Number(person.id));return{id:person.id,socketId:connection?.id,name:person.name,avatar_color:person.avatar_color,joined:connectedUserIds.has(Number(person.id)),role:Number(person.id)===Number(user.id)?'You':person.role}}),
    ...extraJoined.map(person=>({id:`socket-${person.id}`,socketId:person.id,name:person.name,avatar_color:person.avatarColor,joined:true,role:'Participant'})),
  ];
  const joinedCount=roster.filter(person=>person.joined).length,notJoinedCount=roster.length-joinedCount;
  const remoteStreams=new Map(remotes.map(remote=>[remote.id,remote.stream]));

  return <div className="meeting-room-overlay">
    <header><div className="meeting-room-brand"><img src="/dsslogo.31878f461bb1d61573f8.jpg"/><span><strong>{meeting.title}</strong><small>Connected · Encrypted DSS Flow meeting</small></span></div><div className="meeting-header-actions"><b>{elapsed}</b><button className="copy-invite" onClick={copyInvite}><Copy/> Copy invite link</button></div></header>
    <div className="meeting-stage">
      <div className={`internal-video-grid participants-${Math.min(roomPeople.length+1,4)}`}>
        <div className="video-tile local"><video ref={localVideo} autoPlay muted playsInline/><div className={`camera-placeholder ${camera?'hidden':''}`}><ParticipantAvatar person={user} size={72}/><strong>{mediaWarning||'Camera is off'}</strong></div><span>{user.name} (You)</span>{raised&&<i className="raised-hand-badge">✋</i>}{!ready&&!error&&<div className="video-loading"><div className="loader"/><span>Joining meeting...</span></div>}</div>
        {roomPeople.map(person=><div className="remote-wrap" key={person.id}><ParticipantVideo participant={{...person,stream:remoteStreams.get(person.id),camera:mediaStates[person.id]?.camera??person.media?.camera}}/>{raisedHands[person.id]&&<i className="raised-hand-badge">✋</i>}</div>)}
        {error&&<div className="meeting-error"><Video/><strong>Unable to join</strong><p>{error}</p></div>}
      </div>
      {panel&&<aside className="meeting-side-panel"><div className="meeting-panel-head"><strong>{panel==='chat'?'Meeting chat':'People'}</strong><button onClick={()=>setPanel(null)}><X/></button></div>{panel==='chat'?<><div className="meeting-chat-list">{chatMessages.length?chatMessages.map(item=><article key={item.id} className={item.userId===user.id?'own':''}><strong>{item.userName}</strong><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small></article>):<div className="meeting-panel-empty"><MessageCircle/><span>No messages yet</span></div>}</div><form className="meeting-chat-compose" onSubmit={sendChat}><input value={chatText} onChange={event=>setChatText(event.target.value)} placeholder="Message everyone"/><button><Send/></button></form></>:<><div className="meeting-people-summary"><strong>{joinedCount} joined</strong><span>{notJoinedCount} not joined</span></div><div className="meeting-people-list">{roster.map(person=><article key={person.id} className={person.joined?'joined':'not-joined'}><ParticipantAvatar person={person}/><span><strong>{person.name}</strong><small>{person.role||'Invitee'}</small></span><div className={`meeting-presence ${person.joined?'online':'offline'}`}><i/>{person.joined?'Joined':'Not joined'}</div>{person.socketId&&raisedHands[person.socketId]&&<b className="people-hand">✋</b>}</article>)}</div></>}</aside>}
    </div>
    <div className="meeting-footer"><div className="participant-total"><strong>{joinedCount}</strong><span>{joinedCount===1?'Participant':'Participants'} joined</span></div><div className="meeting-controls"><button className={mic?'':'off'} onClick={()=>toggleTrack('audio')}><Mic/>{mic?'Mute':'Unmute'}</button><button disabled={meeting.meeting_mode==='voice'||!streamRef.current?.getVideoTracks().length} className={camera?'':'off'} onClick={()=>toggleTrack('video')}><Video/>{camera?'Stop camera':'Start camera'}</button><button className={sharing?'active':''} onClick={share}><MonitorUp/>{sharing?'Sharing':'Share screen'}</button><button className={raised?'active':''} onClick={toggleHand}><Hand/>{raised?'Lower hand':'Raise hand'}</button><button className={panel==='chat'?'active':''} onClick={()=>setPanel(panel==='chat'?null:'chat')}><MessageCircle/>Chat</button><button className={panel==='people'?'active':''} onClick={()=>setPanel(panel==='people'?null:'people')}><UsersRound/>People ({joinedCount})</button><button onClick={toggleFullscreen}><Maximize/>Full screen</button></div><button className="meeting-leave" onClick={onClose}><PhoneCall/> Leave</button></div>
  </div>;
}
