const assert = require('assert/strict');
const { normalizePaper, upsertPaper, paperMarkdown, citationEdges } = require('../app/research-library');

const first = normalizePaper({ title: 'A Study', doi: 'https://doi.org/10.1234/ABC ', authors: ['Alice'], year: 2024, structured: { abstract: 'Evidence' }, sourceAttachmentId: 'att-1' }, { now: 100 });
assert.equal(first.doi, '10.1234/abc');
assert.equal(first.canonicalKey, 'doi:10.1234/abc');
assert.equal(first.sourceAttachmentId, 'att-1');
assert.equal(first.workspace, '科研');

let result = upsertPaper([], first, { now: 100 });
assert.equal(result.created, true);
const update = upsertPaper(result.papers, { title: 'A Study (updated)', doi: '10.1234/abc', metadata: { venue: 'NeurIPS' }, structured: { method: 'Controlled trial' }, reviewed: true }, { now: 200 });
assert.equal(update.created, false);
assert.equal(update.updated, true);
assert.equal(update.papers.length, 1, 'same DOI must update, not duplicate');
assert.equal(update.paper.id, first.id);
assert.equal(update.paper.title, 'A Study (updated)');
assert.equal(update.paper.metadata.venue, 'NeurIPS');
assert.equal(update.paper.structured.abstract, 'Evidence');
assert.equal(update.paper.structured.method, 'Controlled trial');
assert.equal(update.paper.sourceAttachmentId, 'att-1');

const stateResult = upsertPaper({ papers: [] }, { title: 'By arXiv', arxivId: 'https://arxiv.org/abs/1234.5678v2' }, { now: 300 });
assert.equal(stateResult.papers.length, 1);
assert.equal(stateResult.paper.arxivId, '1234.5678');

const p1 = normalizePaper({ id: 'p1', title: 'Paper One', doi: '10/a', relations: [{ type: 'cites', targetId: 'p2', source: 'explicit' }, { type: 'topic', targetId: 'p3', source: 'explicit' }] });
const p2 = normalizePaper({ id: 'p2', title: 'Paper Two', doi: '10/b', relations: [{ type: 'cited_by', targetId: 'p1', source: 'explicit' }] });
const p3 = normalizePaper({ id: 'p3', title: 'Paper Three', doi: '10/c', relations: [{ type: 'cites', targetId: 'p2', source: 'inferred' }] });
const edges = citationEdges([p1, p2, p3]);
assert.deepEqual(edges, [{ source: 'p1', target: 'p2', type: 'citation' }], 'only explicit citation relations are graph edges');

const markdown = paperMarkdown({ title: 'A Study', doi: '10.1234/abc', structured: { abstract: 'Evidence' }, reviewed: false });
assert.match(markdown, /title: "A Study"/);
assert.match(markdown, /Evidence/);
assert.match(markdown, /研究动机\n未核验/);
assert.match(markdown, /审阅状态：待审阅/);
console.log('research-library tests passed');
