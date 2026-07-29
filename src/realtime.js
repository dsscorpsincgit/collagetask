import { io as createSocket } from 'socket.io-client';

export const realtime=createSocket({autoConnect:false,path:'/api/realtime'});

export const api=async(path,options)=>{
  const response=await fetch(`/api${path}`,{headers:{'Content-Type':'application/json'},...options});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.error||'Request failed')}
  return response.status===204?null:response.json();
};
