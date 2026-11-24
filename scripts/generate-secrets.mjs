import { randomBytes } from "node:crypto";

const secret = () => randomBytes(32).toString("hex");

console.log(`ADMIN_TOKEN=${secret()}`);
console.log(`SESSION_SECRET=${secret()}`);
console.log(`STREAM_SECRET=${secret()}`);
