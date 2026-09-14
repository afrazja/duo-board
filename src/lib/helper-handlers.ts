import { db } from "./db";
import { requireUser } from "./account-auth";
import { helperHandlers } from "./helper-api";

export const helper = helperHandlers({ rpc: (name, args) => db().rpc(name, args), requireUser });
