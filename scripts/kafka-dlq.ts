/**
 * Inspect or replay a dead-letter topic.
 *
 *   npm run kafka:dlq -- order.events            list messages not replayed yet (read-only)
 *   npm run kafka:dlq -- order.events --replay   republish them to order.events
 *
 * A replayed message goes back to its original topic with its original key, value and headers,
 * so every consumer group sees it again. Groups that had already handled it skip it through
 * durable idempotency; only the group whose handler failed runs it. Progress is tracked by the
 * `delivery-plus-dlq-replay` consumer group, so each message is replayed once. Unparseable
 * messages can't be replayed and are only listed (and marked as seen on --replay).
 *
 * KAFKA_BROKER defaults to localhost:9092 (the dev and test stacks publish it).
 */
import { IHeaders, Kafka, logLevel } from 'kafkajs';

// Same default partitioner as the services' producers; the notice about the v2 change is noise here.
process.env.KAFKAJS_NO_PARTITIONER_WARNING ??= '1';

const DEAD_LETTER_SUFFIX = '.dlq';
const REPLAY_GROUP = 'delivery-plus-dlq-replay';
const H = {
  originalTopic: 'dlq-original-topic',
  originalPartition: 'dlq-original-partition',
  originalOffset: 'dlq-original-offset',
  consumerGroup: 'dlq-consumer-group',
  reason: 'dlq-reason',
  error: 'dlq-error',
  failedAt: 'dlq-failed-at',
};

async function main() {
  const args = process.argv.slice(2);
  const replay = args.includes('--replay');
  const topicArg = args.find((a) => !a.startsWith('--'));
  if (!topicArg) {
    console.error('Usage: npm run kafka:dlq -- <topic> [--replay]   (e.g. order.events)');
    process.exit(2);
  }
  const dlq = topicArg.endsWith(DEAD_LETTER_SUFFIX) ? topicArg : `${topicArg}${DEAD_LETTER_SUFFIX}`;
  const broker = process.env.KAFKA_BROKER || 'localhost:9092';

  const kafka = new Kafka({ clientId: 'dlq-tool', brokers: [broker], logLevel: logLevel.WARN });
  const admin = kafka.admin();
  await admin.connect();

  let pending: Map<number, { from: bigint; to: bigint }>;
  try {
    const topics = await admin.listTopics();
    if (!topics.includes(dlq)) {
      console.log(`${dlq} does not exist: nothing has been dead-lettered.`);
      return;
    }
    // Snapshot the end of each partition: messages dead-lettered while we run wait for the next run.
    const ends = await admin.fetchTopicOffsets(dlq);
    const [committed] = await admin.fetchOffsets({ groupId: REPLAY_GROUP, topics: [dlq] });
    pending = new Map();
    for (const end of ends) {
      const done = committed?.partitions.find((p) => p.partition === end.partition)?.offset ?? '-1';
      const from = BigInt(done === '-1' ? end.low : done);
      const to = BigInt(end.high);
      if (from < to) pending.set(end.partition, { from, to });
    }
  } finally {
    await admin.disconnect();
  }

  const total = [...pending.values()].reduce((n, r) => n + Number(r.to - r.from), 0);
  if (total === 0) {
    console.log(`${dlq}: nothing pending.`);
    return;
  }
  console.log(`${dlq}: ${total} message(s) pending${replay ? ', replaying' : ' (read-only; add --replay to republish)'}`);

  const producer = kafka.producer();
  const consumer = kafka.consumer({ groupId: REPLAY_GROUP });
  if (replay) await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: dlq, fromBeginning: true });

  let replayed = 0;
  let skipped = 0;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out reading the dead-letter topic')), 120_000);
    const finishIfDone = () => {
      if (pending.size === 0) {
        clearTimeout(timeout);
        resolve();
      }
    };

    consumer
      .run({
        autoCommit: false,
        eachMessage: async ({ partition, message }) => {
          const range = pending.get(partition);
          const offset = BigInt(message.offset);
          if (!range || offset < range.from || offset >= range.to) return;

          const headers = message.headers ?? {};
          const originalTopic = header(headers, H.originalTopic);
          const reason = header(headers, H.reason);
          const summary = describe(message.value);
          console.log(
            `  ${partition}@${message.offset}  ${summary}  group=${header(headers, H.consumerGroup)} ` +
              `reason=${reason} at=${header(headers, H.failedAt)}\n      error: ${header(headers, H.error)}`,
          );

          if (replay) {
            if (reason === 'unparseable' || !originalTopic) {
              skipped++;
              console.log('      skipped: not a replayable event');
            } else {
              await producer.send({
                topic: originalTopic,
                messages: [{ key: message.key, value: message.value, headers: withoutDeadLetterHeaders(headers) }],
              });
              replayed++;
              console.log(`      replayed to ${originalTopic}`);
            }
            await consumer.commitOffsets([{ topic: dlq, partition, offset: (offset + 1n).toString() }]);
          }

          if (offset + 1n >= range.to) {
            pending.delete(partition);
            finishIfDone();
          }
        },
      })
      .catch(reject);
  });

  await consumer.disconnect();
  if (replay) {
    await producer.disconnect();
    console.log(`Replayed ${replayed}, skipped ${skipped}.`);
  }
}

function header(headers: IHeaders, name: string): string {
  const value = headers[name];
  if (value === undefined) return '';
  return (Array.isArray(value) ? value[0] : value)?.toString() ?? '';
}

function withoutDeadLetterHeaders(headers: IHeaders): IHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith('dlq-')));
}

function describe(value: Buffer | null): string {
  try {
    const event = JSON.parse(value?.toString() ?? '');
    return `${event.eventType} ${event.eventId} order=${event.payload?.orderId ?? '-'}`;
  } catch {
    return '(unparseable)';
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
