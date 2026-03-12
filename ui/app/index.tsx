import { useMemo, useState } from 'react';

import CodefleetScreen from '../codefleet';
import { createCodefleetMcpClient } from '../src/mcp/client';

const DEFAULT_AGENT = 'codefleet';
const DEFAULT_BASE_URL = process.env.EXPO_PUBLIC_CODEFLEET_BASE_URL ?? 'http://localhost:3000';

export default function Index() {
  const [endpoint, setEndpoint] = useState(DEFAULT_BASE_URL);

  const endpointStore = useMemo(
    () => ({
      get: () => endpoint,
      set: (next: string | null) => {
        setEndpoint(next ?? DEFAULT_BASE_URL);
      },
    }),
    [endpoint],
  );

  const client = useMemo(
    () =>
      createCodefleetMcpClient({
        agentName: DEFAULT_AGENT,
        getBaseUrl: endpointStore.get,
        clientInfo: {
          name: 'codefleet-ui-standalone',
          version: '0.1.0',
        },
      }),
    [endpointStore],
  );

  return <CodefleetScreen client={client} endpointStore={endpointStore} />;
}
