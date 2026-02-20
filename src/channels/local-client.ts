#!/usr/bin/env node
/**
 * Local CLI Channel for TinyClaw
 *
 * Injects a message into the queue and polls for the response.
 * This gives `tinyclaw send` full agent/team routing capabilities
 * without requiring an external channel (Telegram, Discord, WhatsApp).
 *
 * Usage: node --import=tsx src/channels/local-client.ts "message text"
 *        node --import=tsx src/channels/local-client.ts "@dev build a REST API"
 *        node --import=tsx src/channels/local-client.ts "@developer fix the login bug"
 *
 * The message goes through the full queue pipeline:
 *   1. Written to QUEUE_INCOMING as MessageData JSON
 *   2. Queue processor picks it up, routes by @agent/@team prefix
 *   3. Agent invoked with teammate injection
 *   4. Response written to QUEUE_OUTGOING
 *   5. This script finds the response, prints it, cleans up
 */

import fs from 'fs';
import path from 'path';
import { QUEUE_INCOMING, QUEUE_OUTGOING } from '../lib/config';
import { MessageData, ResponseData } from '../lib/types';

const CHANNEL = 'local';
const SENDER = process.env.USER || 'cli';
const SENDER_ID = `local_${SENDER}`;
const POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes — team conversations can be lengthy

// Ensure queue directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

function generateMessageId(): string {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `local_${ts}_${rand}`;
}

function writeIncomingMessage(message: string, messageId: string): void {
    const data: MessageData = {
        channel: CHANNEL,
        sender: SENDER,
        senderId: SENDER_ID,
        message,
        timestamp: Date.now(),
        messageId,
    };

    const filePath = path.join(QUEUE_INCOMING, `${messageId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

async function pollForResponse(messageId: string, timeoutMs: number): Promise<ResponseData | null> {
    const deadline = Date.now() + timeoutMs;
    const prefix = `${CHANNEL}_${messageId}`;

    while (Date.now() < deadline) {
        try {
            const files = fs.readdirSync(QUEUE_OUTGOING);
            const match = files.find(f => f.startsWith(prefix) && f.endsWith('.json'));

            if (match) {
                const filePath = path.join(QUEUE_OUTGOING, match);
                const raw = fs.readFileSync(filePath, 'utf8');
                const response: ResponseData = JSON.parse(raw);

                // Clean up the response file
                fs.unlinkSync(filePath);

                return response;
            }
        } catch {
            // Directory might not exist yet or race condition on file read
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return null;
}

function printResponse(response: ResponseData): void {
    console.log(response.message);

    if (response.files && response.files.length > 0) {
        console.log('');
        console.log('Attached files:');
        for (const file of response.files) {
            console.log(`  ${file}`);
        }
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Parse flags
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    let noWait = false;
    const messageArgs: string[] = [];

    for (const arg of args) {
        if (arg.startsWith('--timeout=')) {
            timeoutMs = parseInt(arg.split('=')[1], 10) * 1000;
        } else if (arg === '--no-wait') {
            noWait = true;
        } else {
            messageArgs.push(arg);
        }
    }

    const message = messageArgs.join(' ').trim();

    if (!message) {
        console.error('Usage: local-client <message> [--timeout=seconds] [--no-wait]');
        console.error('');
        console.error('Examples:');
        console.error('  local-client "@dev build a REST API"');
        console.error('  local-client "@developer fix the login bug"');
        console.error('  local-client "hello" --timeout=60');
        process.exit(2);
    }

    const messageId = generateMessageId();

    // Write message to incoming queue
    writeIncomingMessage(message, messageId);

    if (noWait) {
        console.log(`Message queued: ${messageId}`);
        process.exit(0);
    }

    // Poll for response
    const response = await pollForResponse(messageId, timeoutMs);

    if (!response) {
        console.error(`Timed out after ${timeoutMs / 1000}s waiting for response.`);
        console.error('Is the queue processor running? Check: tinyclaw status');
        process.exit(1);
    }

    printResponse(response);
}

main().catch(err => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
