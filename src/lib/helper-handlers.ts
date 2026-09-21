import { db } from "./db";
import { requireUser } from "./account-auth";
import { helperHandlers } from "./helper-api";
import { listRemovedHelperThreads } from "./helper-removals";
import { cleanupFinishedTranscription, prepareTranscriptionRequests } from "./helper-transcription";

export const helper = helperHandlers({
  rpc: (name, args) => db().rpc(name, args), requireUser,
  listRemovedThreads: (ownerId, threadIds) => listRemovedHelperThreads(db(), ownerId, threadIds),
  prepareReceive: prepareTranscriptionRequests,
  afterResult: cleanupFinishedTranscription,
});
