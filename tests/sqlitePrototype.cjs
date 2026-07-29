const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { gzipSync } = require('node:zlib');

function elapsed(start) {
  return Math.round((performance.now() - start) * 100) / 100;
}

function mib(bytes) {
  return Math.round((bytes / 1024 / 1024) * 1000) / 1000;
}

async function main() {
  const packageRoot = process.argv[2];
  if (!packageRoot) throw new Error('需要传入临时 sql.js 包目录');
  const initSqlJs = require(path.join(packageRoot, 'dist', 'sql-wasm.js'));
  const wasmPath = path.join(packageRoot, 'dist', 'sql-wasm.wasm');
  const initStarted = performance.now();
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const wasmInitMs = elapsed(initStarted);
  const rowCounts = [1_000, 10_000, 100_000];
  const results = [];

  for (const rowCount of rowCounts) {
    const db = new SQL.Database();
    db.run(`
      PRAGMA journal_mode = MEMORY;
      PRAGMA synchronous = OFF;
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        character_name TEXT NOT NULL,
        floor_start INTEGER NOT NULL,
        floor_end INTEGER NOT NULL,
        story_time TEXT NOT NULL,
        keywords TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX idx_memories_character_floor
        ON memories(character_name, floor_end DESC);
      CREATE INDEX idx_memories_kind_floor
        ON memories(kind, floor_end DESC);
    `);

    const insertStarted = performance.now();
    db.run('BEGIN');
    const insert = db.prepare(`
      INSERT INTO memories
        (id, kind, character_name, floor_start, floor_end, story_time, keywords, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < rowCount; index += 1) {
      const character = `角色${index % 40}`;
      const floor = index * 2 + 1;
      insert.run([
        `memory-${index}`,
        index % 3 === 0 ? 'summary' : 'character_memory',
        character,
        floor,
        floor + 1,
        `景历${Math.floor(index / 100) + 1}年`,
        `密信,地点${index % 20},${character}`,
        `${character}在第${floor}层记住了一段用于 SQLite 压力测试的事件，编号${index}。`,
      ]);
    }
    insert.free();
    db.run('COMMIT');
    const insertMs = elapsed(insertStarted);

    const firstExportStarted = performance.now();
    const firstSnapshot = db.export();
    const firstExportMs = elapsed(firstExportStarted);
    db.close();

    const reopenStarted = performance.now();
    const reopened = new SQL.Database(firstSnapshot);
    const reopenMs = elapsed(reopenStarted);

    const queryStarted = performance.now();
    let queryRows = 0;
    for (let index = 0; index < 100; index += 1) {
      const result = reopened.exec(
        `SELECT id, floor_end, text
           FROM memories
          WHERE character_name = $character
            AND floor_end BETWEEN $floorStart AND $floorEnd
          ORDER BY floor_end DESC
          LIMIT 20`,
        {
          $character: `角色${index % 40}`,
          $floorStart: Math.max(0, rowCount - 5000),
          $floorEnd: rowCount * 2 + 1,
        },
      );
      queryRows += result[0]?.values.length ?? 0;
    }
    const indexedQuery100Ms = elapsed(queryStarted);

    const updateStarted = performance.now();
    reopened.run('UPDATE memories SET text = ? WHERE id = ?', [
      '只修改了一条记忆，但持久化到世界书仍需要重新导出数据库文件。',
      `memory-${Math.floor(rowCount / 2)}`,
    ]);
    const updateOneRowMs = elapsed(updateStarted);

    const secondExportStarted = performance.now();
    const secondSnapshot = reopened.export();
    const exportAfterOneUpdateMs = elapsed(secondExportStarted);
    reopened.close();

    const base64Characters = Math.ceil(secondSnapshot.byteLength / 3) * 4;
    const gzipStarted = performance.now();
    const gzipped = gzipSync(secondSnapshot);
    const gzipMs = elapsed(gzipStarted);
    const gzipBase64Characters = Math.ceil(gzipped.byteLength / 3) * 4;
    results.push({
      rowCount,
      insertMs,
      sqliteBytes: secondSnapshot.byteLength,
      sqliteMiB: mib(secondSnapshot.byteLength),
      firstExportMs,
      reopenMs,
      indexedQuery100Ms,
      queryRows,
      updateOneRowMs,
      exportAfterOneUpdateMs,
      gzipMs,
      gzipBytes: gzipped.byteLength,
      gzipMiB: mib(gzipped.byteLength),
      worldbookBase64Characters: base64Characters,
      worldbookChunksAt22000: Math.ceil(base64Characters / 22_000),
      gzipWorldbookChunksAt22000: Math.ceil(gzipBase64Characters / 22_000),
      heapUsedMiB: mib(process.memoryUsage().heapUsed),
    });
  }

  console.log(JSON.stringify({
    engine: 'sql.js',
    wasmInitMs,
    node: process.version,
    results,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
