// Writes example channels in the shape the indexer consumes, so the whole pipeline can be run
// without a Discord bot token:  node scripts/fixture.mjs ./fixture && node dist/cli.js sync --seed ./fixture
import { mkdirSync, writeFileSync } from "node:fs";

const dir = process.argv[2] ?? "./fixture";
mkdirSync(dir, { recursive: true });

const at = (minutesAgo) => Date.now() - minutesAgo * 60_000;
const message = (id, author, content, minutesAgo, replyTo = null) => ({
  id,
  replyTo,
  timestamp: at(minutesAgo),
  editedTimestamp: null,
  content,
  authorId: `u-${author}`,
  authorName: author,
  attachments: [],
});
const channel = (id, name, categoryName, messages, type = "0") => ({
  guild: { id: "111111111111111111", name: "Example Server" },
  channel: { id, name, type, topic: null, categoryId: `cat-${categoryName}`, categoryName },
  messages,
});

writeFileSync(
  `${dir}/engineering.json`,
  JSON.stringify(
    channel("100", "engineering", "Product", [
      message("1", "ada", "the database migration is blocked on the schema rewrite", 600),
      message("2", "grace", "can we ship the settings page before it lands?", 598),
      message("3", "ada", "yes, that page is independent. merging today", 596),
      // A reply the next day: no time window would group these, the reply pointer does.
      message("4", "grace", "the rewrite broke staging overnight", 90, "1"),
      message("5", "ada", "rolling it back now", 88),
    ]),
  ),
);
writeFileSync(
  `${dir}/random.json`,
  JSON.stringify(
    channel("200", "random", "Social", [
      message("6", "grace", "lunch?", 300),
      message("7", "ada", "in ten minutes", 299),
    ]),
  ),
);

console.log(`wrote 2 example channels to ${dir}`);
