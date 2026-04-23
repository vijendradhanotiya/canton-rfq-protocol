// Copyright (c) 2024 Digital Asset (Switzerland) GmbH and/or its affiliates. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'crypto';

// --- Type Definitions ---
// These types should ideally be generated from the DAR using `dpm codegen-js`.
// They are manually defined here for clarity.

/** Represents a Daml Party identifier. */
export type Party = string;

/** Represents a Daml ContractId. */
export type ContractId = string;

/** Generic structure for a contract returned from the JSON API. */
export interface DamlContract<T> {
  contractId: ContractId;
  templateId: string;
  payload: T;
}

export enum Side {
  Buy = "Buy",
  Sell = "Sell",
}

export interface RFQRequest {
  requester: Party;
  marketMakers: Party[];
  instrument: string;
  quantity: string; // Decimal
  side: Side;
  deadline: string; // Time
  requestId: string;
}

export interface HashedQuote {
  marketMaker: Party;
  hashedQuote: string; // Hash
}

export interface QuoteGroup {
  requester: Party;
  originalRequest: RFQRequest;
  quotes: HashedQuote[];
  respondedMakers: Party[];
  deadline: string; // Time
}

export interface Quote {
  marketMaker: Party;
  price: string; // Decimal
}

export interface RevealedQuote {
  quote: Quote;
  nonce: string;
}

export interface WinnerSelection {
  requester: Party;
  winningMaker: Party;
  winningQuote: Quote;
  originalRequest: RFQRequest;
  losingMakers: Party[];
}

export interface Trade {
    buyer: Party;
    seller: Party;
    instrument: string;
    quantity: string; // Decimal
    price: string; // Decimal;
    tradeId: string;
}

// --- Client Configuration ---

export interface RfqClientConfig {
  /** The base URL of the Canton participant's JSON API. E.g., http://localhost:7575 */
  ledgerUrl: string;
  /** The party ID to act as. */
  party: Party;
  /** The JWT used to authorize JSON API requests. */
  token: string;
  /** The package ID of the main RFQ contract model. */
  mainPackageId: string;
}

// --- Hashing Utility ---

/**
 * Creates a SHA-256 hash of a quote and a nonce, matching the Daml implementation.
 * Note: This client-side hashing is for demonstration. In a production system,
 * the hashing logic must be identical to the one used in the Daml model.
 * Daml's `hashSha256` operates on a specific binary representation. A robust
 * implementation would require a shared, well-defined serialization format.
 * For this example, we assume a simple UTF-8 JSON string representation.
 * @param quote The quote object to hash.
 * @param nonce A random string to salt the hash.
 * @returns A hex-encoded SHA-256 hash.
 */
async function createQuoteHash(quote: Quote, nonce: string): Promise<string> {
  const message = JSON.stringify({ quote, nonce });
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

/**
 * Generates a cryptographically secure random nonce.
 * @returns A hex-encoded random string.
 */
export function generateNonce(): string {
  return randomBytes(32).toString('hex');
}


// --- RFQ Client ---

/**
 * A TypeScript SDK for interacting with the Canton RFQ protocol contracts
 * via the JSON API.
 */
export class RfqClient {
  private readonly config: RfqClientConfig;
  private readonly authHeaders: Record<string, string>;
  private readonly modulePrefix: string;

  constructor(config: RfqClientConfig) {
    this.config = config;
    this.modulePrefix = `${config.mainPackageId}:RFQ`;
    this.authHeaders = {
      'Authorization': `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    };
  }

  // --- Command Submission ---

  /**
   * Creates a new RFQ request, broadcasting it to the specified market makers.
   */
  public async createRfq(request: Omit<RFQRequest, 'requester'>): Promise<DamlContract<RFQRequest>> {
    const payload = {
      requester: this.config.party,
      ...request,
    };

    return this.createContract(`${this.modulePrefix}.Request:RFQRequest`, payload);
  }

  /**
   * Submits a sealed quote in response to an RFQ request.
   * This function handles hashing the quote before submission.
   */
  public async submitSealedQuote(
    rfqRequestCid: ContractId,
    price: string, // Decimal
    nonce: string,
  ): Promise<any> {
    const quote: Quote = { marketMaker: this.config.party, price };
    const hashedQuote = await createQuoteHash(quote, nonce);

    const choiceArgs = {
      quote,
      nonce,
      hashedQuote,
    };

    return this.exerciseChoice(
      `${this.modulePrefix}.Request:RFQRequest`,
      rfqRequestCid,
      "SubmitSealedQuote",
      choiceArgs
    );
  }

  /**
   * As the requester, selects the winning quote from a group of sealed quotes.
   * This requires revealing all submitted quotes and nonces.
   */
  public async selectWinner(
    quoteGroupCid: ContractId,
    revealedQuotes: RevealedQuote[]
  ): Promise<any> {
    return this.exerciseChoice(
      `${this.modulePrefix}.Request:QuoteGroup`,
      quoteGroupCid,
      "SelectWinner",
      { revealedQuotes }
    );
  }

  /**
   * As the winning market maker, executes the trade based on the winner selection.
   */
  public async executeTrade(winnerSelectionCid: ContractId): Promise<any> {
    return this.exerciseChoice(
      `${this.modulePrefix}.WinnerSelection:WinnerSelection`,
      winnerSelectionCid,
      "ExecuteTrade",
      {}
    );
  }

  // --- Contract Queries ---

  /** Finds all active RFQ requests where the client party is a stakeholder. */
  public async findRfqRequests(): Promise<DamlContract<RFQRequest>[]> {
    return this.queryContracts(`${this.modulePrefix}.Request:RFQRequest`);
  }

  /** Finds all active Quote Groups where the client party is a stakeholder. */
  public async findQuoteGroups(): Promise<DamlContract<QuoteGroup>[]> {
    return this.queryContracts(`${this.modulePrefix}.Request:QuoteGroup`);
  }

  /** Finds all active Winner Selections where the client party is a stakeholder. */
  public async findWinnerSelections(): Promise<DamlContract<WinnerSelection>[]> {
    return this.queryContracts(`${this.modulePrefix}.WinnerSelection:WinnerSelection`);
  }

  /** Finds all active Trades where the client party is a stakeholder. */
  public async findTrades(): Promise<DamlContract<Trade>[]> {
    return this.queryContracts(`${this.modulePrefix}.TradeExecution:Trade`);
  }

  // --- Private JSON API Helpers ---

  private async createContract<T>(templateId: string, payload: T): Promise<any> {
    const body = JSON.stringify({
      templateId,
      payload,
    });
    return this.post('/v1/create', body);
  }

  private async exerciseChoice(
    templateId: string,
    contractId: ContractId,
    choice: string,
    argument: object
  ): Promise<any> {
    const body = JSON.stringify({
      templateId,
      contractId,
      choice,
      argument,
    });
    return this.post('/v1/exercise', body);
  }

  private async queryContracts<T>(templateId: string): Promise<DamlContract<T>[]> {
    const body = JSON.stringify({ templateIds: [templateId] });
    const response = await this.post('/v1/query', body);
    return response.result;
  }

  private async post(endpoint: string, body: string): Promise<any> {
    const url = `${this.config.ledgerUrl}${endpoint}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders,
        body,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`JSON API request failed with status ${response.status}: ${errorBody}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Error during fetch to ${url}:`, error);
      throw error;
    }
  }
}