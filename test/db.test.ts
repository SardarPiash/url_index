import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database, migrate } from '../src/db.js';
import { report, toCsv } from '../src/report.js';
import { limitation } from '../src/core.js';

test('PostgreSQL persistence and evidence-based report', { skip: process.env.TEST_DATABASE !== '1' }, async () => {
  const pool = database();
  const id = randomUUID();
  try {
    await migrate(pool);
    await migrate(pool);
    await pool.query(`INSERT INTO experiments(id,method,limitations) VALUES ($1,'baseline',$2)`, [id, limitation]);
    await pool.query(`INSERT INTO observations(experiment_id,target_url,state) VALUES ($1,'https://example.com/control','SUBMITTED')`, [id]);
    let result = await report(pool, id);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].final_result, 'UNKNOWN');
    assert.equal(result.summary[0]!.confirmed_indexed, 0);
    assert.equal(result.summary[0]!.median_seconds_to_crawl, null);
    assert.equal(result.summary[0]!.unknown, 1);
    await assert.rejects(pool.query(`INSERT INTO observations(experiment_id,target_url,state) VALUES ($1,'https://example.com/control','SUBMITTED')`, [id]));
    // Synthetic evidence only, scoped to this test and deleted afterward.
    await pool.query(`UPDATE observations SET first_verified_crawl_at=(SELECT started_at + interval '10 seconds' FROM experiments WHERE id=$1), index_confirmed_at=(SELECT started_at + interval '20 seconds' FROM experiments WHERE id=$1), index_status='INDEX_CONFIRMED', index_evidence_source='synthetic test fixture', final_result='INDEX_CONFIRMED', state='INDEX_CONFIRMED' WHERE experiment_id=$1`, [id]);
    result = await report(pool, id);
    assert.equal(result.summary[0]!.median_seconds_to_crawl, 10);
    assert.equal(result.summary[0]!.median_seconds_to_index, 20);
    assert.equal(result.summary[0]!.confirmed_indexed, 1);
    assert.match(toCsv(result.rows), /seconds_to_index/);
  } finally {
    await pool.query('DELETE FROM observations WHERE experiment_id=$1', [id]);
    await pool.query('DELETE FROM experiments WHERE id=$1', [id]);
    await pool.end();
  }
});
