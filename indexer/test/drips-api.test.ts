import assert from "assert";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OWNER = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBYM";
const MEMBER_ONE = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCOA";
const MEMBER_TWO = "GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDG";

async function request(server: http.Server, pathname: string): Promise<{ status: number; body: any }> {
  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`);
  return { status: response.status, body: await response.json() };
}

async function run(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vestflow-drips-api-"));
  process.env.INDEXER_DB_PATH_TESTNET = path.join(tempDir, "testnet.db");

  const { getDb } = await import("../src/db");
  const { createServer } = await import("../src/server");
  const db = getDb("testnet");
  db.prepare("INSERT INTO drips_lists (id, name, owner, token, total_funding_rate_per_sec, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("list-1", "Team", OWNER, "TOKEN", "55", 100);
  db.prepare("INSERT INTO drips_list_members (list_id, address, joined_at) VALUES (?, ?, ?)")
    .run("list-1", MEMBER_ONE, 10);
  db.prepare("INSERT INTO drips_list_members (list_id, address, joined_at) VALUES (?, ?, ?)")
    .run("list-1", MEMBER_TWO, 20);
  db.prepare("INSERT INTO drips_streams (id, account, receiver, token, rate_per_second, estimated_end_time, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("stream-1", ACCOUNT, MEMBER_ONE, "TOKEN", "8", Math.floor(Date.now() / 1000) + 3600, 100);
  db.prepare("INSERT INTO drips_streaming_balances (account, token, balance) VALUES (?, ?, ?)")
    .run(ACCOUNT, "TOKEN", "123");

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const lists = await request(server, "/lists?limit=1");
    assert.equal(lists.status, 200);
    assert.deepEqual(lists.body.lists[0], {
      id: "list-1", name: "Team", owner: OWNER, token: "TOKEN",
      total_funding_rate_per_sec: "55", member_count: 2,
    });

    const members = await request(server, "/lists/list-1/members?limit=1");
    assert.equal(members.status, 200);
    assert.deepEqual(members.body.members, [{ address: MEMBER_ONE, joined_at: 10 }]);
    assert(members.body.next_cursor);
    const memberPageTwo = await request(server, `/lists/list-1/members?cursor=${encodeURIComponent(members.body.next_cursor)}`);
    assert.deepEqual(memberPageTwo.body.members, [{ address: MEMBER_TWO, joined_at: 20 }]);
    assert.equal((await request(server, "/lists/missing/members")).status, 404);

    const streams = await request(server, `/streams?account=${ACCOUNT}`);
    assert.equal(streams.status, 200);
    assert.equal(streams.body.streams.length, 1);
    assert.equal((await request(server, "/streams")).status, 400);

    const tvl = await request(server, "/analytics/streams/tvl?token=TOKEN");
    assert.equal(tvl.status, 200);
    assert.equal(tvl.body.total_value_locked, "123");
    assert.equal((await request(server, "/analytics/streams/tvl?token=NONE")).body.total_value_locked, "0");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().then(() => console.log("Drips API tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
