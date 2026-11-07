import { S3Client } from '@aws-sdk/client-s3';

export interface S3Clients {
  region: string;
  /** Talks to object storage from inside the service network. */
  client: S3Client;
  /** Signs URLs for browsers and apps; differs from `client` when the public endpoint does (local Compose). */
  signingClient: S3Client;
}

/**
 * The S3 clients every storage service uses, from the shared AWS_* settings. Production has no local
 * endpoint or fallback credentials: it uses the AWS default credential chain (a role) unless keys are set.
 */
export function createS3Clients(env: NodeJS.ProcessEnv = process.env): S3Clients {
  const isProduction = env.NODE_ENV === 'production';
  const region = env.AWS_REGION || 'us-east-1';

  const endpoint = env.AWS_S3_ENDPOINT || (isProduction ? undefined : 'http://localhost:9000');
  const publicEndpoint = env.AWS_S3_PUBLIC_ENDPOINT || endpoint;
  const forcePathStyle = env.AWS_S3_FORCE_PATH_STYLE === undefined
    ? Boolean(endpoint)
    : env.AWS_S3_FORCE_PATH_STYLE === 'true';
  const credentials = env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      }
    : isProduction
      ? undefined
      : { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };

  const clientConfig = {
    region,
    endpoint,
    forcePathStyle,
    ...(credentials ? { credentials } : {}),
  };

  const client = new S3Client(clientConfig);
  const signingClient = publicEndpoint && publicEndpoint !== endpoint
    ? new S3Client({ ...clientConfig, endpoint: publicEndpoint })
    : client;
  return { region, client, signingClient };
}
