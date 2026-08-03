import { defineApp } from 'convex/server';
import r2 from '@convex-dev/r2/convex.config';

// Stems live in Cloudflare R2, not Convex file storage: R2 has no egress fee,
// and a 4-minute song is tens of MB that get re-fetched on every play.
const app = defineApp();
app.use(r2);

export default app;
