// 人狼GM - online worker (no chat feature by design)
// Rooms are handled by a Durable Object per room code.
// Only game actions travel over the network: join, start, night actions, votes.
// There is intentionally NO endpoint that accepts free-text messages.
const ROLE_DEFS = {
  wolf:{name:"人狼"}, madman:{name:"狂人"}, seer:{name:"占い師"},
  knight:{name:"騎士"}, medium:{name:"霊媒師"}, villager:{name:"村人"}
};
function defaultRoles(n){
  const wolves = n>=13?3:(n>=7?2:1);
  const cfg = {wolf:wolves, seer:1, knight:0, medium:n>=9?1:0, madman:n>=7?1:0, villager:0}; // 騎士なし（本人指定ルール）
  cfg.villager = n - (cfg.wolf+cfg.seer+cfg.knight+cfg.medium+cfg.madman);
  return cfg;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function token(){ return crypto.randomUUID().replace(/-/g,""); }
function json(obj, status){ return new Response(JSON.stringify(obj), {status:status||200, headers:{"content-type":"application/json; charset=utf-8"}}); }

export class RoomDO {
  constructor(state, env){ this.state=state; this.env=env; this.data=null; }
  async load(){
    if(!this.data){ this.data = await this.state.storage.get("data") || null; }
    return this.data;
  }
  async save(){ await this.state.storage.put("data", this.data); }
  auth(body){
    const p = this.data && this.data.players.find(x=>x.id===body.pid);
    if(!p || p.token!==body.token) return null;
    return p;
  }
  alive(){ return this.data.players.filter(p=>p.alive); }
  wolves(){ return this.data.players.filter(p=>p.alive && p.role==="wolf"); }
  nonWolves(){ return this.data.players.filter(p=>p.alive && p.role!=="wolf"); }
  checkWin(){
    const w=this.wolves().length, v=this.nonWolves().length;
    if(this.data.phase==="lobby") return false;
    if(w===0){ this.data.phase="end"; this.data.winner="village"; this.data.endReason="人狼が全員いなくなりました。"; return true; }
    if(w>=v){ this.data.phase="end"; this.data.winner="wolf"; this.data.endReason="人狼の数が村人側と同数以上になりました。"; return true; }
    return false;
  }
  nightComplete(){
    const d=this.data, n=d.night;
    const wolfDone = d.day===1 ? true : n.kill!==null; // 初日襲撃なし
    const seer = d.players.find(p=>p.alive&&p.role==="seer");
    const seerDone = !seer || n.seerActed;
    const knight = d.players.find(p=>p.alive&&p.role==="knight");
    const knightDone = !knight || n.knightActed; // online: knight can guard from night 1
    return wolfDone && seerDone && knightDone;
  }
  async resolveNight(){
    const d=this.data, n=d.night;
    let msg="";
    if(n.kill!==null && n.kill!==undefined){
      const victim=d.players[n.kill];
      if(n.guard===victim.id){ msg="昨晩は襲撃がありましたが、誰も死にませんでした。"; d.publicLog.push(d.day+"日目朝：襲撃は護衛で防がれた"); }
      else { victim.alive=false; msg=victim.name+" さんが無残な姿で発見されました。"; d.publicLog.push(d.day+"日目朝："+victim.name+" が死亡"); }
    } else { msg="昨晩は誰も死にませんでした。"; }
    d.morningMsg=msg;
    d.lastGuard = (n.guard===undefined? null:n.guard);
    d.phase="morning";
    this.checkWin();
  }
  resolveVote(){
    const d=this.data, count={};
    Object.values(d.votes).forEach(t=>{ count[t]=(count[t]||0)+1; });
    let max=0; Object.values(count).forEach(c=>{ if(c>max)max=c; });
    const tops=Object.keys(count).filter(k=>count[k]===max).map(Number);
    const detail=this.alive().map(p=>p.name+"："+(count[p.id]||0)+"票").join("、");
    d.voteDetail=detail;
    if(tops.length>1){ d.voteMsg="同票のため、今日は処刑されませんでした。"; d.lastExecuted=null; d.publicLog.push(d.day+"日目：同票で処刑なし（"+detail+"）"); }
    else {
      const t=d.players[tops[0]]; t.alive=false; d.lastExecuted=t.id;
      d.voteMsg=t.name+" さんが処刑されました。";
      d.publicLog.push(d.day+"日目："+t.name+" が処刑（"+detail+"）");
      // medium result (private)
      const med=d.players.find(p=>p.role==="medium");
      if(med) d.mediumResult={forId:med.id, targetName:t.name, isWolf:t.role==="wolf", day:d.day};
    }
    d.phase="voteResult";
    this.checkWin();
  }
  view(me){
    const d=this.data;
    const v={
      room:d.room, phase:d.phase, day:d.day,
      players:d.players.map(p=>({id:p.id, name:p.name, alive:p.alive, host:p.id===d.hostId})),
      meId: me?me.id:null, isHost: me? me.id===d.hostId:false,
      myAlive: me? me.alive:null,
      publicLog:d.publicLog, morningMsg:d.morningMsg||"", voteMsg:d.voteMsg||"", voteDetail:d.voteDetail||"",
      winner:d.winner||null, endReason:d.endReason||""
    };
    if(me && d.phase!=="lobby"){
      v.myRole=me.role; v.myRoleName=ROLE_DEFS[me.role].name;
      if(me.role==="wolf") v.wolfMates=d.players.filter(p=>p.role==="wolf"&&p.id!==me.id).map(p=>p.name);
      if(d.seerResults && d.seerResults[me.id]) v.seerResult=d.seerResults[me.id];
      if(d.mediumResult && d.mediumResult.forId===me.id && me.role==="medium") v.mediumResult=d.mediumResult;
    }
    if(d.phase==="end"){ v.allRoles=d.players.map(p=>({name:p.name, role:ROLE_DEFS[p.role].name, alive:p.alive})); }
    // pending action for me
    v.action=null; v.acted=false; v.canAdvance=false;
    if(me && me.alive){
      const n=d.night;
      if(d.phase==="night"){
        if(me.role==="wolf"){
          if(d.day===1){ v.acted=true; v.waitInfo="初日は襲撃できません（初日襲いなしルール）"; }
          else if(n.kill===null) v.action={type:"wolf", title:"🐺 襲撃する人を選んでください", targets:this.nonWolves().map(p=>({id:p.id,name:p.name}))};
          else { v.acted=true; v.waitInfo="今晩の襲撃先は "+d.players[n.kill].name+" です"; }
        } else if(me.role==="seer"){
          if(!n.seerActed) v.action={type:"seer", title:"🔮 占う人を選んでください", targets:this.alive().filter(p=>p.id!==me.id).map(p=>({id:p.id,name:p.name}))};
          else v.acted=true;
        } else if(me.role==="knight"){
          if(!n.knightActed) v.action={type:"knight", title:"🛡️ 護衛する人を選んでください", targets:this.alive().filter(p=>p.id!==me.id && p.id!==d.lastGuard).map(p=>({id:p.id,name:p.name}))};
          else v.acted=true;
        }
      } else if(d.phase==="voting"){
        if(d.votes[me.id]===undefined) v.action={type:"vote", title:"🗳️ 処刑したい人に投票", targets:this.alive().filter(p=>p.id!==me.id).map(p=>({id:p.id,name:p.name}))};
        else v.acted=true;
      }
    }
    if(me && me.id===d.hostId && ["morning","discussion","voteResult"].includes(d.phase)) v.canAdvance=true;
    // progress hints
    if(d.phase==="night") v.waiting="夜の行動が終わるのを待っています…";
    if(d.phase==="voting") v.waiting="全員の投票を待っています（"+Object.keys(d.votes).length+"/"+this.alive().length+"）";
    return v;
  }
  async fetch(request){
    const url=new URL(request.url);
    const path=url.pathname.replace(/^\/api/,"");
    const body = request.method==="POST" ? await request.json().catch(()=>({})) : {};
    if(path==="/create"){
      const name=String(body.name||"").trim().slice(0,12);
      if(!name) return json({error:"名前を入れてください"},400);
      const pid=0;
      this.data={ room:url.searchParams.get("room")||"", hostId:pid, phase:"lobby", day:0,
        players:[{id:pid,name,token:token(),role:null,alive:true}],
        night:null, votes:{}, publicLog:["部屋が作られました"], seerResults:{}, mediumResult:null,
        lastGuard:null, lastExecuted:null, morningMsg:"", voteMsg:"", voteDetail:"", winner:null, endReason:"" };
      await this.save();
      return json({room:this.data.room, pid, token:this.data.players[0].token});
    }
    await this.load();
    if(!this.data) return json({error:"部屋が見つかりません"},404);
    if(path==="/join"){
      if(this.data.phase!=="lobby") return json({error:"ゲームは既に始まっています"},400);
      const name=String(body.name||"").trim().slice(0,12);
      if(!name) return json({error:"名前を入れてください"},400);
      if(this.data.players.some(p=>p.name===name)) return json({error:"同じ名前の人がいます"},400);
      if(this.data.players.length>=15) return json({error:"部屋が満員です"},400);
      const pid=Math.max(...this.data.players.map(p=>p.id))+1;
      const tk=token();
      this.data.players.push({id:pid,name,token:tk,role:null,alive:true});
      this.data.publicLog.push(name+" が参加しました");
      await this.save();
      return json({room:this.data.room, pid, token:tk});
    }
    if(path==="/state"){
      const me=this.auth({pid:Number(url.searchParams.get("pid")), token:url.searchParams.get("token")});
      if(!me) return json({error:"認証エラー。再参加してください"},401);
      return json(this.view(me));
    }
    // everything below needs auth in body
    const me=this.auth(body);
    if(!me) return json({error:"認証エラー"},401);
    if(path==="/start"){
      if(me.id!==this.data.hostId) return json({error:"ホストだけが開始できます"},403);
      if(this.data.phase!=="lobby") return json({error:"開始済みです"},400);
      const n=this.data.players.length;
      if(n<4) return json({error:"4人以上必要です"},400);
      const cfg=defaultRoles(n);
      const deck=[]; Object.keys(cfg).forEach(k=>{ for(let i=0;i<cfg[k];i++) deck.push(k); });
      shuffle(deck);
      this.data.players.forEach((p,i)=>{ p.role=deck[i]; p.alive=true; });
      this.data.day=1; this.data.phase="night";
      this.data.night={kill:null, guard:null, seerActed:false, knightActed:false};
      this.data.publicLog.push("ゲーム開始："+n+"人（"+"人狼×"+cfg.wolf+" 占い師×"+cfg.seer+(cfg.knight?" 騎士×"+cfg.knight:"")+(cfg.medium?" 霊媒師×"+cfg.medium:"")+(cfg.madman?" 狂人×"+cfg.madman:"")+" 村人×"+cfg.villager+"）");
      await this.save();
      return json(this.view(me));
    }
    if(path==="/night"){
      const d=this.data;
      if(d.phase!=="night" || !me.alive) return json({error:"今は夜の行動はできません"},400);
      const target=Number(body.target); const tp=d.players[target];
      if(!tp || !tp.alive || tp.id===me.id) return json({error:"対象が不正です"},400);
      if(me.role==="wolf"){
        if(d.day===1) return json({error:"初日は襲撃できません"},400);
        if(d.night.kill!==null) return json({error:"襲撃先は決定済みです"},400);
        if(tp.role==="wolf") return json({error:"人狼は襲撃できません"},400);
        d.night.kill=target;
      } else if(me.role==="seer"){
        if(d.night.seerActed) return json({error:"占い済みです"},400);
        d.night.seerActed=true;
        d.seerResults[me.id]={targetName:tp.name, isWolf:tp.role==="wolf", day:d.day};
      } else if(me.role==="knight"){
        if(d.night.knightActed) return json({error:"護衛済みです"},400);
        if(d.lastGuard===target) return json({error:"同じ人を2晩連続では護衛できません"},400);
        d.night.knightActed=true; d.night.guard=target;
      } else return json({error:"あなたの役職に夜の行動はありません"},400);
      if(this.nightComplete()) await this.resolveNight();
      await this.save();
      return json(this.view(me));
    }
    if(path==="/vote"){
      const d=this.data;
      if(d.phase!=="voting" || !me.alive) return json({error:"今は投票できません"},400);
      if(d.votes[me.id]!==undefined) return json({error:"投票済みです"},400);
      const target=Number(body.target); const tp=d.players[target];
      if(!tp || !tp.alive || tp.id===me.id) return json({error:"対象が不正です"},400);
      d.votes[me.id]=target;
      if(Object.keys(d.votes).length>=this.alive().length) this.resolveVote();
      await this.save();
      return json(this.view(me));
    }
    if(path==="/advance"){
      const d=this.data;
      if(me.id!==d.hostId) return json({error:"ホストだけが進められます"},403);
      if(d.phase==="morning"){ d.phase="discussion"; }
      else if(d.phase==="discussion"){ d.phase="voting"; d.votes={}; }
      else if(d.phase==="voteResult"){
        d.day++; d.phase="night"; d.night={kill:null, guard:null, seerActed:false, knightActed:false}; d.voteMsg=""; d.voteDetail="";
      } else return json({error:"今は進められません"},400);
      await this.save();
      return json(this.view(me));
    }
    return json({error:"not found"},404);
  }
}

const CODE_CHARS="ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function makeCode(){
  let s=""; const a=new Uint8Array(4); crypto.getRandomValues(a);
  a.forEach(b=>{ s+=CODE_CHARS[b%CODE_CHARS.length]; });
  return s;
}
export default {
  async fetch(request, env){
    const url=new URL(request.url);
    if(url.pathname.startsWith("/api/")){
      let room=(url.searchParams.get("room")||"").toUpperCase();
      let bodyRoom=null;
      if(request.method==="POST"){
        try{ const clone=request.clone(); const b=await clone.json(); bodyRoom=(b.room||"").toUpperCase()||null; }catch(e){}
      }
      if(url.pathname==="/api/create" && !room){ room=makeCode(); }
      room = room || bodyRoom || "";
      if(!room) return json({error:"部屋コードが必要です"},400);
      const id=env.ROOMS.idFromName(room);
      const stub=env.ROOMS.get(id);
      const fwd=new URL(url.toString()); fwd.searchParams.set("room", room);
      return stub.fetch(new Request(fwd.toString(), request));
    }
    return env.ASSETS.fetch(request);
  }
};
