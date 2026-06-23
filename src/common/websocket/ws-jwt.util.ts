import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';

/**
 * Shared handshake-token convention for all Socket.io gateways in this app:
 * `auth.token` or `?token=` query param, optionally prefixed with "Bearer ".
 * See architecture_design/WEBSOCKET_PROTOCOL.md.
 */
export function extractWsToken(client: Socket): string {
  const auth = client.handshake.auth as { token?: unknown } | undefined;
  const token = auth?.token ?? client.handshake.query?.token;

  if (!token || typeof token !== 'string') {
    throw new WsException('Missing token');
  }

  return token.startsWith('Bearer ') ? token.slice(7) : token;
}
