import { SignJWT } from "jose";
import { loadConfig } from "../src/config.js";

const config = loadConfig();
if (config.NODE_ENV === "production") throw new Error("Development token generation is disabled in production.");
const userId = process.argv[2] ?? "demo-user";
if (!userId.trim() || userId.length > 200) throw new Error("User ID must contain between 1 and 200 characters.");
const token = await new SignJWT({})
  .setProtectedHeader({ alg: "HS256", typ: "JWT" })
  .setSubject(userId)
  .setIssuer(config.JWT_ISSUER)
  .setAudience(config.JWT_AUDIENCE)
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(config.JWT_SECRET));
console.log(token);
