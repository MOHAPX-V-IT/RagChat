import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-not-for-deployment-32';
const { default: app } = await import('../src/server.js');
const { store } = await import('../src/store.js');
const { signToken } = await import('../src/auth.js');
const { propose } = await import('../src/discussion.js');

test('real HTTP routes: independent editors, owner selection, conflict and rep privacy', async () => {
  const users = ['EXPERT','EXPERT','SPECIALIST','REQUESTER','ADMIN','MANAGER'].map((role,i) => ({id:`u${i}`,role,firstName:'Тест',lastName:`${i}`,isActive:true}));
  const task={id:'t',conversationId:'c',questionMessageId:'m',representativeId:'u3',assignedTo:'u0',reviewPool:'GENERAL',status:'IN_REVIEW',aiDraft:'Original AI draft',createdAt:new Date().toISOString()};
  propose(task,users[0],task.aiDraft);
  const data={users,reviewTasks:[task],messages:[{id:'m',conversationId:'c',content:'Question',isOfficial:true,createdAt:task.createdAt}],conversations:[{id:'c',ownerId:'u3',title:'Test'}],auditEvents:[],notifications:[],knowledgeEntries:[],settings:{}};
  store.read=()=>structuredClone(data);
  let queue=Promise.resolve();
  store.mutate=(fn)=>{const next=queue.then(()=>fn(data));queue=next.catch(()=>{});return next;};
  const server=app.listen(0,'127.0.0.1');
  await new Promise((resolve)=>server.once('listening',resolve));
  const request=async(user,path,body)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${signToken(user)}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  };
  try {
    const before=structuredClone(task.discussion);
    const saves=await Promise.all([request(users[1],'reviews/t/revisions',{content:'General revision',baseVersion:1}),request(users[2],'reviews/t/revisions',{content:'Specialist revision',baseVersion:1})]);
    assert.deepEqual(saves.map((r)=>r.status),[201,201]);assert.equal(task.revisions.length,2);
    assert.deepEqual(task.discussion,before);
    const revisionId=saves[0].body.revision.id;
    assert.equal((await request(users[1],'reviews/t/select-revision',{revisionId,version:1})).status,409);
    const vote=await request(users[2],'reviews/t/vote',{version:1,value:'YES'});assert.equal(vote.status,200);
    const choices=await Promise.all([request(users[0],'reviews/t/select-revision',{revisionId,version:1}),request(users[0],'reviews/t/select-revision',{revisionId:saves[1].body.revision.id,version:1})]);
    assert.deepEqual(choices.map((r)=>r.status).sort(),[200,409]);assert.equal(task.discussion.version,2);
    assert.equal(task.discussion.answer,'General revision');assert.equal(task.discussion.votes.length,0);
    assert.equal(task.discussionHistory[0].votes.length,1);
    assert.equal((await request(users[3],'reviews/t')).status,403);
    assert.equal((await request(users[3],'reviews/t/revisions',{content:'No access'})).status,403);
    const rep=(await request(users[3],'conversations/c/messages')).body;
    for(const key of ['discussion','revisions','aiDraft','internalComments','discussionHistory']) assert.equal(Object.hasOwn(rep.activeTask,key),false);
    assert.equal(rep.messages.length,1);assert.equal(rep.messages[0].content,'Question');
    task.status='DELIVERED';
    assert.equal((await request(users[1],'reviews/t/revisions',{content:'Too late'})).status,409);
    assert.equal((await request(users[0],'reviews/t/select-revision',{revisionId,version:2})).status,409);
  } finally { await new Promise((resolve)=>server.close(resolve)); }
});
