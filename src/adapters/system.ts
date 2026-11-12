import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Clock, IdGenerator, ShareTokenGenerator } from "../usecases/ports.js";

export const systemClock: Clock = { now: () => new Date() };

/** Ids are UUIDv7 generated here, not by the database. */
export const randomIds: IdGenerator = {
  newId: () => uuidv7(),
};

/** The token of a share link: 32 bytes from the operating system's random source, base64url (43 characters). */
export const randomShareTokens: ShareTokenGenerator = {
  newToken: () => randomBytes(32).toString("base64url"),
};
