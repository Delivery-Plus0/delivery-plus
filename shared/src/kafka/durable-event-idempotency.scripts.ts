/**
 * Lua scripts backing DurableEventIdempotencyService. Each runs atomically on
 * the Redis server, so no other client can interleave between the read and the
 * write, and lease expiry is judged by the Redis clock rather than any app
 * server's clock.
 *
 * Key states:
 *   missing           -> unclaimed (or a lease/processed marker expired)
 *   "lease:<token>"   -> claimed by the consumer holding <token>, expires via PX
 *   "processed"       -> handled successfully, kept for the retention TTL
 *
 * Internal to the idempotency service; not exported from the package index.
 */

/**
 * KEYS[1] = event key, ARGV[1] = lease value, ARGV[2] = lease TTL ms.
 *
 * If the key already holds this exact lease value, the command is a re-send of
 * an acquire Redis already executed (ioredis resends unanswered commands after
 * a reconnect by default), so it answers "acquired" again instead of telling
 * the real lease holder the event is "in-progress". The lease TTL is not
 * extended by the re-send.
 */
export const ACQUIRE_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') then
  return 'acquired'
end
local current = redis.call('GET', KEYS[1])
if current == ARGV[1] then
  return 'acquired'
end
if current == 'processed' then
  return 'processed'
end
return 'in-progress'
`;

/**
 * KEYS[1] = event key, ARGV[1] = caller's lease value, ARGV[2] = retention TTL ms.
 *
 *   already "processed"          -> untouched (value and TTL kept), returns 0
 *   caller still owns the lease  -> becomes "processed", returns 1
 *   anything else                -> becomes "processed", returns 0
 *
 * The last case covers a caller whose lease expired (key missing) or was taken
 * over by another consumer. The caller's handler did run, so the event is
 * recorded as processed even over the other consumer's live lease: that
 * consumer's work is already a duplicate, and leaving the event unmarked would
 * let a third consumer run it again if that consumer later fails and releases.
 * The 0 tells the caller the handler may have run concurrently elsewhere.
 */
export const MARK_PROCESSED_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == 'processed' then
  return 0
end
redis.call('SET', KEYS[1], 'processed', 'PX', ARGV[2])
if current == ARGV[1] then
  return 1
end
return 0
`;

/**
 * KEYS[1] = event key, ARGV[1] = caller's lease value. Deletes the key only if
 * the caller still owns the lease, so a slow consumer whose lease expired can
 * never release another consumer's lease or erase a processed marker.
 */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
