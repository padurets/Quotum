import {config} from '../config.js';
import type {Provider} from '../domain/sources.js';

/**
 * The only integration point with CodexBar: its loopback HTTP `/usage` API.
 * No vendor HTML, no Swift fork, no model prompts.
 */
export class VendorClient {
  constructor(
    private readonly baseUrl = config.vendor.baseUrl,
    private readonly token = config.vendor.token,
  ) {
    if (!token) throw new Error('Missing internal source token');
  }

  async usage(provider: Provider, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/usage?provider=${provider}`, {
      headers: {Authorization: `Bearer ${this.token}`},
      signal,
    });
    if (!response.ok) throw new Error('source_unavailable');
    return response.json();
  }
}
