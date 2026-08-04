import { useEffect, useRef, useState } from 'react';
import { Copy, Hand, Maximize, MessageCircle, Mic, MonitorUp, PhoneCall, Send, UsersRound, Video, X } from 'lucide-react';
import { api, realtime } from './realtime';

const initials=name=>String(name||'').split(' ').map(part=>part[0]).join('').slice(0,2).toUpperCase();
const chatDayKey=value=>new Date(value).toLocaleDateString('en-CA');
const chatDayLabel=value=>{const date=new Date(value),today=new Date(),yesterday=new Date();yesterday.setDate(today.getDate()-1);const key=chatDayKey(value);if(key===chatDayKey(today))return'Today';if(key===chatDayKey(yesterday))return'Yesterday';return date.toLocaleDateString([],{day:'numeric',month:'short',year:date.getFullYear()===today.getFullYear()?undefined:'numeric'})};

function ParticipantAvatar({person,size=34}) {
  return <span className="avatar" style={{width:size,height:size,background:person.avatar_color||person.avatarColor||'#2c5de5'}}>{initials(person.name)}</span>;
}

function ParticipantVideo({participant}) {
  const video=useRef(null);
  useEffect(()=>{if(video.current)video.current.srcObject=participant.stream||null},[participant.stream]);
  const showingVideo=Boolean(participant.stream&&(participant.screenSharing||participant.camera!==false)&&participant.stream.getVideoTracks().length);
  return <div className={`video-tile remote ${participant.screenSharing?'screen-share-tile':''}`}>
    <video ref={video} autoPlay playsInline/>
    <div className={`camera-placeholder ${showingVideo?'hidden':''}`}><ParticipantAvatar person={participant} size={72}/><strong>{participant.camera===false?'Camera is off':participant.stream?'Connecting video...':'Connecting...'}</strong></div>
    <span>{participant.name}{participant.screenSharing?' · presenting':''}</span>
  </div>;
}

export default function EnhancedMeetingRoom({meeting,user,users=[],onClose}) {
  const localVideo=useRef(null),streamRef=useRef(null),screenStreamRef=useRef(null),peers=useRef(new Map()),pendingIce=useRef(new Map()),clientId=useRef(crypto.randomUUID()),mediaRef=useRef({mic:true,camera:meeting.meeting_mode!=='voice',screenSharing:false}),panelRef=useRef(null);
  const[remotes,setRemotes]=useState([]),[roomPeople,setRoomPeople]=useState([]),[mediaStates,setMediaStates]=useState({});
  const[mic,setMic]=useState(true),[camera,setCamera]=useState(meeting.meeting_mode!=='voice'),[sharing,setSharing]=useState(false),[ready,setReady]=useState(false);
  const[error,setError]=useState(''),[mediaWarning,setMediaWarning]=useState(''),[panel,setPanel]=useState(null),[seconds,setSeconds]=useState(0);
  const[chatMessages,setChatMessages]=useState([]),[chatText,setChatText]=useState(''),[chatPopup,setChatPopup]=useState(null),[raised,setRaised]=useState(false),[raisedHands,setRaisedHands]=useState({});

  useEffect(()=>{const timer=setInterval(()=>setSeconds(value=>value+1),1000);return()=>clearInterval(timer)},[]);
  useEffect(()=>{panelRef.current=panel;if(panel==='chat')setChatPopup(null)},[panel]);
  useEffect(()=>{if(!chatPopup)return;const timer=setTimeout(()=>setChatPopup(null),5000);return()=>clearTimeout(timer)},[chatPopup]);

  useEffect(()=>{
    let active=true,pollTimer,lastSignalId=0,lastMessageId=0,polling=false,chatLoaded=false,detachSocket=()=>{};
    const knownParticipants=new Set();
    const setup=async()=>{
      try {
        const config=await api('/webrtc-config');
        let stream;
        try {stream=await navigator.mediaDevices.getUserMedia({video:meeting.meeting_mode!=='voice',audio:true})}
        catch(mediaError){
          if(meeting.meeting_mode!=='voice')try{stream=await navigator.mediaDevices.getUserMedia({video:false,audio:true});setMediaWarning('Camera is unavailable. You joined with your microphone only.')}catch{/* Report the original media error below. */}
          if(!stream){stream=new MediaStream();setMediaWarning(mediaError.name==='NotAllowedError'?'Camera and microphone are blocked. Allow browser access to share them.':'No camera or microphone is available on this device.')}
        }
        if(!active){stream.getTracks().forEach(track=>track.stop());return}
        streamRef.current=stream;
        if(localVideo.current)localVideo.current.srcObject=stream;
        const initialMic=Boolean(stream.getAudioTracks()[0]?.enabled),initialCamera=Boolean(stream.getVideoTracks()[0]?.enabled);
        mediaRef.current={mic:initialMic,camera:initialCamera,screenSharing:false};setMic(initialMic);setCamera(initialCamera);setReady(true);
        api('/users/me/status',{method:'PATCH',body:JSON.stringify({work_status:'in_meeting'})}).catch(()=>{});

        const sendSignal=(target,type,payload)=>api(`/meetings/${encodeURIComponent(meeting.room_name)}/live/signal`,{method:'POST',body:JSON.stringify({client_id:clientId.current,target,type,payload})}).catch(signalError=>{if(signalError.message!=='Participant is no longer connected')console.warn('Meeting signal:',signalError.message)});
        const addRemote=(id,remoteStream)=>setRemotes(current=>[...current.filter(person=>person.id!==id),{id,stream:remoteStream}]);
        const getPeer=id=>{
          if(peers.current.has(id))return peers.current.get(id);
          const peer=new RTCPeerConnection(config);
          stream.getAudioTracks().forEach(track=>peer.addTrack(track,stream));
          const outgoingVideo=screenStreamRef.current?.getVideoTracks()[0]||stream.getVideoTracks()[0];
          if(outgoingVideo)peer.addTrack(outgoingVideo,screenStreamRef.current||stream);
          if(!stream.getAudioTracks().length)peer.addTransceiver('audio',{direction:'recvonly'});
          if(!stream.getVideoTracks().length)peer.addTransceiver('video',{direction:'sendrecv'});
          peer.onicecandidate=event=>event.candidate&&sendSignal(id,'ice',event.candidate.toJSON());
          peer.ontrack=event=>addRemote(id,event.streams[0]||new MediaStream([event.track]));
          peer.onconnectionstatechange=()=>{if(['failed','closed'].includes(peer.connectionState)){setRemotes(current=>current.filter(person=>person.id!==id));peers.current.delete(id);pendingIce.current.delete(id);knownParticipants.delete(id)}};
          peers.current.set(id,peer);
          return peer;
        };
        const queueIce=(id,candidate)=>pendingIce.current.set(id,[...(pendingIce.current.get(id)||[]),candidate]);
        const flushIce=async(id,peer)=>{const queued=pendingIce.current.get(id)||[];pendingIce.current.delete(id);for(const candidate of queued)try{await peer.addIceCandidate(candidate)}catch{/* A reconnect can invalidate an old candidate. */}};
        const receiveOffer=async(from,offer)=>{try{const peer=getPeer(from);await peer.setRemoteDescription(offer);await flushIce(from,peer);const answer=await peer.createAnswer();await peer.setLocalDescription(answer);await sendSignal(from,'answer',answer)}catch(connectionError){console.warn('Unable to answer meeting connection:',connectionError.message)}};
        const receiveAnswer=async(from,answer)=>{try{const peer=peers.current.get(from);if(peer){await peer.setRemoteDescription(answer);await flushIce(from,peer)}}catch(connectionError){console.warn('Unable to complete meeting connection:',connectionError.message)}};
        const receiveIce=async(from,candidate)=>{const peer=peers.current.get(from);if(!peer||!peer.remoteDescription){queueIce(from,candidate);return}try{await peer.addIceCandidate(candidate)}catch{/* Another candidate may still connect. */}};
        const poll=async()=>{
          if(polling||!active)return;polling=true;
          try{
            const result=await api(`/meetings/${encodeURIComponent(meeting.room_name)}/live/poll`,{method:'POST',body:JSON.stringify({client_id:clientId.current,after_id:lastSignalId,after_message_id:lastMessageId,...mediaRef.current})});
            if(!active)return;setError('');
            const list=(result.participants||[]).filter(person=>person.id!==clientId.current),currentIds=new Set(list.map(person=>person.id));
            setRoomPeople(list);setMediaStates(Object.fromEntries(list.map(person=>[person.id,person.media||{mic:false,camera:false}])));
            for(const[id,peer]of peers.current)if(!currentIds.has(id)){peer.close();peers.current.delete(id);pendingIce.current.delete(id);knownParticipants.delete(id);setRemotes(current=>current.filter(person=>person.id!==id))}
            for(const person of list){
              if(knownParticipants.has(person.id))continue;knownParticipants.add(person.id);
              if(clientId.current.localeCompare(person.id)<0)try{const peer=getPeer(person.id),offer=await peer.createOffer();await peer.setLocalDescription(offer);await sendSignal(person.id,'offer',offer)}catch(connectionError){console.warn('Unable to offer meeting connection:',connectionError.message)}
            }
            for(const signal of result.signals||[]){lastSignalId=Math.max(lastSignalId,Number(signal.id));if(signal.signal_type==='offer')await receiveOffer(signal.from_client_id,signal.payload);else if(signal.signal_type==='answer')await receiveAnswer(signal.from_client_id,signal.payload);else if(signal.signal_type==='ice')await receiveIce(signal.from_client_id,signal.payload)}
            if(result.messages?.length){lastMessageId=Math.max(lastMessageId,...result.messages.map(item=>Number(item.id)));if(chatLoaded&&panelRef.current!=='chat'){const incoming=[...result.messages].reverse().find(item=>Number(item.userId)!==Number(user.id));if(incoming)setChatPopup(incoming)}setChatMessages(current=>{const ids=new Set(current.map(item=>String(item.id)));return[...current,...result.messages.filter(item=>!ids.has(String(item.id)))]})}chatLoaded=true;
          }catch(pollError){if(active)setError(current=>current||pollError.message)}finally{polling=false}
        };
        const receiveHand=item=>setRaisedHands(current=>({...current,[item.socketId]:item.raised?item.userName:undefined}));
        const joinSocket=()=>realtime.emit('join-meeting',{roomName:meeting.room_name,media:mediaRef.current});
        realtime.on('meeting-hand',receiveHand);realtime.on('connect',joinSocket);if(realtime.connected)joinSocket();
        detachSocket=()=>{realtime.off('meeting-hand',receiveHand);realtime.off('connect',joinSocket)};
        await poll();pollTimer=setInterval(poll,1000);
      } catch(setupError) {setError(setupError.message||'Unable to connect to the meeting')}
    };
    setup();
    return()=>{active=false;clearInterval(pollTimer);detachSocket();realtime.emit('leave-meeting',{roomName:meeting.room_name});api(`/meetings/${encodeURIComponent(meeting.room_name)}/live/${clientId.current}`,{method:'DELETE'}).catch(()=>{});screenStreamRef.current?.getTracks().forEach(track=>track.stop());streamRef.current?.getTracks().forEach(track=>track.stop());peers.current.forEach(peer=>peer.close());peers.current.clear();pendingIce.current.clear();api('/users/me/status',{method:'PATCH',body:JSON.stringify({work_status:'available'})}).catch(()=>{})};
  },[meeting.room_name,meeting.meeting_mode]);

  const toggleTrack=kind=>{const track=streamRef.current?.getTracks().find(item=>item.kind===kind);if(!track)return;track.enabled=!track.enabled;if(kind==='audio'){mediaRef.current={...mediaRef.current,mic:track.enabled};setMic(track.enabled)}else{mediaRef.current={...mediaRef.current,camera:track.enabled};setCamera(track.enabled)}};
  const share=async()=>{if(sharing||!navigator.mediaDevices?.getDisplayMedia)return;try{const display=await navigator.mediaDevices.getDisplayMedia({video:{cursor:'always'},audio:false}),track=display.getVideoTracks()[0];screenStreamRef.current=display;const replaceVideo=nextTrack=>Promise.all([...peers.current.values()].map(peer=>{const sender=peer.getSenders().find(item=>item.track?.kind==='video')||peer.getTransceivers().find(item=>item.receiver.track?.kind==='video')?.sender;return sender?.replaceTrack(nextTrack)}));await replaceVideo(track);if(localVideo.current)localVideo.current.srcObject=display;mediaRef.current={...mediaRef.current,screenSharing:true};setSharing(true);track.onended=async()=>{const cameraTrack=streamRef.current?.getVideoTracks()[0]||null;await replaceVideo(cameraTrack);screenStreamRef.current=null;if(localVideo.current)localVideo.current.srcObject=streamRef.current;mediaRef.current={...mediaRef.current,screenSharing:false};setSharing(false)}}catch{/* Screen sharing was cancelled. */}};
  const toggleHand=()=>{const next=!raised;setRaised(next);realtime.emit('meeting-hand',{roomName:meeting.room_name,raised:next})};
  const sendChat=async event=>{event.preventDefault();const message=chatText.trim();if(!message)return;setChatText('');try{const item=await api(`/meetings/${encodeURIComponent(meeting.room_name)}/live/chat`,{method:'POST',body:JSON.stringify({client_id:clientId.current,message})});setChatMessages(current=>current.some(existing=>String(existing.id)===String(item.id))?current:[...current,item])}catch(chatError){setChatText(message);setError(chatError.message)}};
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
    {chatPopup&&<button className="meeting-chat-popup" onClick={()=>setPanel('chat')}><ParticipantAvatar person={{name:chatPopup.userName}}/><span><strong>{chatPopup.userName}</strong><p>{chatPopup.message}</p></span><small>{new Date(chatPopup.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small></button>}
    <div className="meeting-stage">
      <div className={`internal-video-grid participants-${Math.min(roomPeople.length+1,4)}`}>
        <div className={`video-tile local ${sharing?'screen-share-tile':''}`}><video ref={localVideo} autoPlay muted playsInline/><div className={`camera-placeholder ${camera||sharing?'hidden':''}`}><ParticipantAvatar person={user} size={72}/><strong>{mediaWarning||'Camera is off'}</strong></div><span>{user.name} (You){sharing?' · presenting':''}</span>{raised&&<i className="raised-hand-badge">✋</i>}{!ready&&!error&&<div className="video-loading"><div className="loader"/><span>Joining meeting...</span></div>}</div>
        {roomPeople.map(person=><div className={`remote-wrap ${person.media?.screenSharing?'presenting':''}`} key={person.id}><ParticipantVideo participant={{...person,stream:remoteStreams.get(person.id),camera:mediaStates[person.id]?.camera??person.media?.camera,screenSharing:person.media?.screenSharing}}/>{raisedHands[person.id]&&<i className="raised-hand-badge">✋</i>}</div>)}
        {error&&<div className="meeting-error"><Video/><strong>Unable to join</strong><p>{error}</p></div>}
      </div>
      {panel&&<aside className="meeting-side-panel">
        <div className="meeting-panel-head"><strong>{panel==='chat'?'Meeting chat':'People'}</strong><button onClick={()=>setPanel(null)}><X/></button></div>
        {panel==='chat'?<>
          <div className="meeting-chat-list">{chatMessages.length?chatMessages.map((item,index)=><div className="meeting-chat-entry" key={item.id}>{(!index||chatDayKey(chatMessages[index-1].createdAt)!==chatDayKey(item.createdAt))&&<div className="meeting-chat-date">{chatDayLabel(item.createdAt)}</div>}<article className={Number(item.userId)===Number(user.id)?'own':''}><strong>{item.userName}</strong><p>{item.message}</p><small>{new Date(item.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</small></article></div>):<div className="meeting-panel-empty"><MessageCircle/><span>No messages yet</span></div>}</div>
          <form className="meeting-chat-compose" onSubmit={sendChat}><input value={chatText} onChange={event=>setChatText(event.target.value)} placeholder="Message everyone"/><button><Send/></button></form>
        </>:<>
          <div className="meeting-people-summary"><strong>{joinedCount} joined</strong><span>{notJoinedCount} not joined</span></div>
          <div className="meeting-people-list">{roster.map(person=><article key={person.id} className={person.joined?'joined':'not-joined'}><ParticipantAvatar person={person}/><span><strong>{person.name}</strong><small>{person.role||'Invitee'}</small></span><div className={`meeting-presence ${person.joined?'online':'offline'}`}><i/>{person.joined?'Joined':'Not joined'}</div>{person.socketId&&raisedHands[person.socketId]&&<b className="people-hand">✋</b>}</article>)}</div>
        </>}
      </aside>}
    </div>
    <div className="meeting-footer"><div className="participant-total"><strong>{joinedCount}</strong><span>{joinedCount===1?'Participant':'Participants'} joined</span></div><div className="meeting-controls"><button className={mic?'':'off'} onClick={()=>toggleTrack('audio')}><Mic/>{mic?'Mute':'Unmute'}</button><button disabled={meeting.meeting_mode==='voice'||!streamRef.current?.getVideoTracks().length} className={camera?'':'off'} onClick={()=>toggleTrack('video')}><Video/>{camera?'Stop camera':'Start camera'}</button><button className={sharing?'active':''} onClick={share}><MonitorUp/>{sharing?'Sharing':'Share screen'}</button><button className={raised?'active':''} onClick={toggleHand}><Hand/>{raised?'Lower hand':'Raise hand'}</button><button className={panel==='chat'?'active':''} onClick={()=>setPanel(panel==='chat'?null:'chat')}><MessageCircle/>Chat</button><button className={panel==='people'?'active':''} onClick={()=>setPanel(panel==='people'?null:'people')}><UsersRound/>People ({joinedCount})</button><button onClick={toggleFullscreen}><Maximize/>Full screen</button></div><button className="meeting-leave" onClick={onClose}><PhoneCall/> Leave</button></div>
  </div>;
}
