import { startPreview } from "./helper-app-server.mjs";
const preview=await startPreview();
console.log(`Isolated helper preview: ${preview.origin} (synthetic account/model; in-memory PostgreSQL)`);
process.on("SIGINT",()=>void preview.close());process.on("SIGTERM",()=>void preview.close());
