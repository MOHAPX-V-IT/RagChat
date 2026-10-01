import test from 'node:test';
import assert from 'node:assert/strict';
import { propose, tally, voteBlock, recordVote, deliveryBlock, archiveDiscussion, pinnedOrder, saveRevision, selectRevision } from './discussion.js';

const author = { id:'expert', role:'EXPERT', firstName:'A', lastName:'B' };
const colleague = { id:'strategy', role:'SPECIALIST', firstName:'C', lastName:'D' };
const base = () => ({ id:'task', status:'IN_REVIEW', representativeId:'rep', aiDraft:'Draft text', createdAt:new Date(0).toISOString() });
const deadline = 24 * 60 * 60_000;

test('proposal waits for discussion, never populates a final answer', () => {
  const task=base(); propose(task, author, 'Edited text',0);
  assert.equal(task.status,'DISCUSSION'); assert.equal(task.finalAnswer,null);
  assert.equal(Date.parse(task.discussion.deadlineAt),deadline);
  assert.equal(task.discussion.edited,true);
});
test('other experts and strategy vote; author, asker and sales cannot', () => {
  const task=base(); propose(task,author,task.aiDraft,0);
  assert.equal(voteBlock(colleague,task,1,1),null);
  for (const user of [author,{...colleague,id:'rep'},{...colleague,role:'MANAGER'}]) assert.ok(voteBlock(user,task,1,1));
  assert.ok(voteBlock(colleague,task,2,1));
  assert.ok(voteBlock(colleague,task,1,deadline));
});
test('one current vote per expert; a changed vote replaces the previous one', () => {
  const task=base(); propose(task,author,task.aiDraft,0);
  recordVote(task,colleague,'YES',1); recordVote(task,colleague,'NO',2);
  assert.equal(task.discussion.votes.length,1); assert.deepEqual(tally(task.discussion),{yes:0,no:1});
});
test('legacy automatic delivery only after 24 hours and a strict yes majority', () => {
  const task=base(); propose(task,author,task.aiDraft,0);
  delete task.discussion.autoReleaseWithoutVotes;
  assert.ok(deliveryBlock(task,null,1,true,deadline));
  recordVote(task,colleague,'YES',1);
  assert.ok(deliveryBlock(task,null,1,true,deadline-1));
  assert.equal(deliveryBlock(task,null,1,true,deadline),null);
  recordVote(task,{...colleague,id:'second'},'NO',1);
  assert.ok(deliveryBlock(task,null,1,true,deadline));
  recordVote(task,{...colleague,id:'third'},'NO',1);
  assert.ok(deliveryBlock(task,null,1,true,deadline));
});

test('new zero-vote round releases only at its own 24 hour deadline', () => {
  const task=base(); propose(task,author,task.aiDraft,100);
  assert.ok(deliveryBlock(task,null,1,true,deadline+99));
  assert.equal(deliveryBlock(task,null,1,true,deadline+100),null);
  recordVote(task,colleague,'NO',101);
  assert.ok(deliveryBlock(task,null,1,true,deadline+100));
});
test('independent revisions preserve the active answer, votes and timer', () => {
  const task=base(); propose(task,author,task.aiDraft,0); recordVote(task,colleague,'YES',1);
  const before=structuredClone(task.discussion);
  saveRevision(task,author,'r1','First expert text',1,2);
  saveRevision(task,colleague,'r2','Second expert text',1,3);
  saveRevision(task,colleague,'r3','Second expert next text',1,4);
  assert.equal(task.revisions.length,3); assert.deepEqual(task.discussion,before);
  assert.equal(task.revisions[1].authorName,'C D');
});
test('selection archives votes, restarts timer and zero votes delivers chosen content', () => {
  const task={...base(),assignedTo:author.id}; propose(task,author,task.aiDraft,0); recordVote(task,colleague,'YES',1);
  saveRevision(task,colleague,'r1','Chosen expert text',1,2);
  assert.throws(()=>selectRevision(task,colleague,'r1',1,3));
  selectRevision(task,author,'r1',1,100);
  assert.equal(task.discussion.answer,'Chosen expert text');
  assert.equal(task.discussion.version,2); assert.equal(task.discussion.votes.length,0);
  assert.equal(task.discussionHistory[0].votes.length,1); assert.equal(task.aiDraft,'Draft text');
  assert.equal(Date.parse(task.discussion.deadlineAt),deadline+100);
  assert.ok(deliveryBlock(task,null,2,true,deadline));
  assert.equal(deliveryBlock(task,null,2,true,deadline+100),null);
  assert.throws(()=>selectRevision(task,author,'r1',1,101));
  assert.throws(()=>selectRevision(task,author,'r1',2,101));
  assert.ok(voteBlock(colleague,task,2,101));
});
test('current assignee selects after transfer; previous assignee loses ownership', () => {
  const task={...base(),assignedTo:author.id}; propose(task,author,task.aiDraft,0);
  saveRevision(task,author,'r1','A revision',1,1); task.assignedTo=colleague.id;
  assert.throws(()=>selectRevision(task,author,'r1',1,2));
  selectRevision(task,colleague,'r1',1,2);
  assert.equal(task.discussion.proposedBy,colleague.id);
});
test('closed, generating, own questions and non-experts cannot save revisions', () => {
  for(const status of ['GENERATING','DELIVERED']) assert.throws(()=>saveRevision({...base(),status},author,'r','text',0));
  for(const user of [{...author,id:'rep'}, {...author,role:'REQUESTER'}, {...author,role:'MANAGER'}, {...author,permissionOverrides:{'reviews.manage':false}}]) {
    assert.throws(()=>saveRevision(base(),user,'r','text',0));
  }
  assert.throws(()=>saveRevision(base(),author,'r','x',0));
  assert.throws(()=>saveRevision(base(),author,'r','x'.repeat(50001),0));
});
test('original author can deliver early despite objections, colleague cannot', () => {
  const task=base(); propose(task,author,task.aiDraft,0); recordVote(task,colleague,'NO',1);
  assert.equal(deliveryBlock(task,author,1,false,2),null);
  assert.equal(deliveryBlock(task,colleague,1,false,2),'owner');
  assert.equal(deliveryBlock(task,{...author,role:'ADMIN',id:'admin'},1,false,2),null);
  assert.ok(deliveryBlock(task,author,2,false,2));
  task.status='DELIVERED'; assert.ok(deliveryBlock(task,author,1,false,2));
});
test('returned versions keep history and restart votes and 24 hour deadline', () => {
  const task=base(); propose(task,author,'Correction',0); recordVote(task,colleague,'YES',1);
  archiveDiscussion(task,'RETURNED',2); task.aiDraft='Correction'; propose(task,colleague,'Correction',100);
  assert.equal(task.discussion.version,2); assert.equal(task.discussion.votes.length,0);
  assert.equal(Date.parse(task.discussion.deadlineAt),deadline+100);
  assert.equal(task.discussionHistory[0].votes.length,1); assert.equal(task.discussion.edited,true);
});
test('addressed returns appear above newer general tasks before pagination', () => {
  const pinned={...base(),id:'pinned',status:'WAITING_REVIEW',returnTo:'expert'};
  const general={...base(),createdAt:new Date(200).toISOString()};
  assert.equal([general,pinned].sort(pinnedOrder('expert'))[0].id,'pinned');
  assert.equal([general,pinned].sort(pinnedOrder('other'))[0].id,'task');
});
