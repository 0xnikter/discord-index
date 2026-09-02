import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StdioClientTransport({
  // process.execPath, not "node": guarantees the server runs on the same Node as this client.
  command: process.execPath, args: ["dist/cli.js", "serve"], cwd: process.cwd(), env: process.env,
}));

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map(t => t.name).join(", "));

const search = await client.callTool({ name: "search_messages", arguments: { query: "what broke in production", limit: 1 } });
const parsed = JSON.parse(search.content[0].text);
console.log("SEARCH mode:", parsed.mode_used, "| hits:", parsed.hits.length);
console.log("  top:", parsed.hits[0]?.messages[0]?.content.slice(0, 60));
console.log("  freshness.stale:", parsed.freshness.stale);

const msgId = parsed.hits[0].messages[0].jump_url.split("/").pop();
const ctx = await client.callTool({ name: "get_context", arguments: { message_id: msgId, before: 2, after: 2 } });
const ctxParsed = JSON.parse(ctx.content[0].text);
console.log("CONTEXT:", ctxParsed.messages.length, "messages in #" + ctxParsed.channel, "| anchor present:", ctxParsed.messages.some(m => m.is_anchor));

const chans = await client.callTool({ name: "list_channels", arguments: {} });
console.log("CHANNELS:", JSON.parse(chans.content[0].text).map(c => `${c.channel}(${c.messages})`).join(", "));

const status = await client.callTool({ name: "sync_status", arguments: {} });
const st = JSON.parse(status.content[0].text);
console.log("STATUS: messages=" + st.messages, "windows=" + st.windows, "embedded=" + st.embedded, "embeddings_enabled=" + st.embeddings_enabled);

const bad = await client.callTool({ name: "get_context", arguments: { message_id: "does-not-exist" } });
console.log("ERROR PATH isError:", bad.isError, "|", bad.content[0].text.slice(0, 60));

await client.close();
