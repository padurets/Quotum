import {Store} from '../store/store.js';
import {Directory} from '../store/directory.js';
import {buildApp,type Hub} from '../api.js';
import {Ingest} from '../ingest.js';
import {Duty} from '../duty.js';
import {Cadence} from '../cadence.js';
import {Pairing} from '../pairing.js';
import {Setup} from '../setup.js';
import {ResetFeed} from '../resets.js';
import {newSecret} from '../domain/auth.js';
import {VIEW_VERSION,VIEW_VERSION_HEADER} from '../domain/view.js';
const M=60_000;export const at=Date.UTC(2026,9,12,12);
export async function centralFixture(){
 const store=new Store(':memory:',at-M),directory=new Directory(store.db),owner=directory.createUser('one@example.test','One','x',at-M),reader=directory.createUser('two@example.test','Two','x',at-M),board=directory.createBoard('Team',owner.id,at-M).id;directory.addMember(board,reader.id,at-M);
 const device=directory.saveDevice({userId:owner.id,machine:{id:'machine-0123456789',name:'Laptop',os:'linux',arch:'x86_64'},agent:'fixture',tokenId:null},at);
 const token=newSecret('qt_s');directory.createSession(token,owner.id,at-M,86_400_000);const otherToken=newSecret('qt_s');directory.createSession(otherToken,reader.id,at-M,86_400_000);
 const hub:Hub={store,directory,ingest:new Ingest(store,directory,new Duty(),new Cadence()),resets:new ResetFeed(undefined,()=>{}),pairing:new Pairing(directory),setup:new Setup(false,null),local:null},app=await buildApp(hub);
 const call=(method:'GET'|'PUT'|'POST',url:string,payload?:object,other=false)=>app.inject({method,url,headers:{origin:'http://localhost',[VIEW_VERSION_HEADER]:String(VIEW_VERSION),cookie:`quotum_session=${other?otherToken:token}`},payload});
 return {store,directory,owner,reader,board,device,hub,app,call};
}
