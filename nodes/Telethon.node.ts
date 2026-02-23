import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { ensurePythonService, getCredentialId, getTelethonBaseUrl } from './telethonRuntime';

const RETRY_ATTEMPTS = 20;
const RETRY_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message;
	return (
		message.includes('ECONNREFUSED') ||
		message.includes('ECONNRESET') ||
		message.includes('EHOSTUNREACH') ||
		message.includes('ENOTFOUND')
	);
}

async function requestWithRetry<T>(requestFn: () => Promise<T>): Promise<T> {
	let lastError: unknown;

	for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
		try {
			return await requestFn();
		} catch (error) {
			lastError = error;
			if (!isRetryableConnectionError(error) || attempt === RETRY_ATTEMPTS) {
				throw error;
			}
			await sleep(RETRY_DELAY_MS);
		}
	}

	throw lastError as Error;
}

export class Telethon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Telethon Send Message',
		name: 'telethon',
		icon: 'file:telegram.svg',
		group: ['transform'],
		version: 1,
		description: 'Send Telegram messages via local Telethon service',
		defaults: {
			name: 'Telethon',
		},
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{
				name: 'telethonApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Chat ID',
				name: 'chatId',
				type: 'string',
				default: '',
				required: true,
			},
			{
				displayName: 'Message',
				name: 'text',
				type: 'string',
				default: '',
				description: 'Text message to send. Optional when File Base64 is provided.',
			},
			{
				displayName: 'File Base64',
				name: 'fileBase64',
				type: 'string',
				default: '',
				description:
					'Optional file payload in Base64. Can be raw base64 or a data URL (data:<mime>;base64,<payload>).',
			},
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: 'file.bin',
				description: 'Optional file name used when sending File Base64.',
			},
			{
				displayName: 'Parse Mode',
				name: 'parseMode',
				type: 'options',
				default: '',
				options: [
					{
						name: 'None',
						value: '',
					},
					{
						name: 'Markdown',
						value: 'markdown',
					},
					{
						name: 'HTML',
						value: 'html',
					},
				],
			},
			{
				displayName: 'Reply To Message ID',
				name: 'replyToMessageId',
				type: 'number',
				default: 0,
				description: 'Optional Telegram message ID to reply to.',
			},
			{
				displayName: 'Silent',
				name: 'silent',
				type: 'boolean',
				default: false,
				description: 'Send message silently (without notification).',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const credentials = await this.getCredentials('telethonApi');
			const baseUrl = getTelethonBaseUrl(credentials as IDataObject);
			ensurePythonService({ baseUrl });
			const credentialId = getCredentialId(credentials as IDataObject);
			const chatId = this.getNodeParameter('chatId', i) as string;
			const text = (this.getNodeParameter('text', i, '') as string).trim();
			const fileBase64 = (this.getNodeParameter('fileBase64', i, '') as string).trim();
			const fileName = (this.getNodeParameter('fileName', i, 'file.bin') as string).trim();
			const parseMode = this.getNodeParameter('parseMode', i, '') as string;
			const replyToMessageId = this.getNodeParameter('replyToMessageId', i, 0) as number;
			const silent = this.getNodeParameter('silent', i, false) as boolean;

			if (!text && !fileBase64) {
				throw new NodeOperationError(
					this.getNode(),
					'Informe Message ou File Base64 para enviar.',
					{ itemIndex: i },
				);
			}

			const requestBody: IDataObject = {
				credential_id: credentialId,
				chat_id: chatId,
				text,
			};

			if (fileBase64) {
				requestBody.file_base64 = fileBase64;
				requestBody.file_name = fileName || 'file.bin';
			}
			if (parseMode) {
				requestBody.parse_mode = parseMode;
			}
			if (replyToMessageId > 0) {
				requestBody.reply_to_message_id = replyToMessageId;
			}
			if (silent) {
				requestBody.silent = true;
			}

			try {
				const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
				const response = (await requestWithRetry(() =>
					this.helpers.httpRequest({
						method: 'POST',
						url: `${normalizedBaseUrl}/${credentialId}/send`,
						body: requestBody,
						json: true,
					}),
				)) as IDataObject;

				if (response.error === 'session_not_found' || response.error === 'not_authenticated') {
					throw new NodeOperationError(
						this.getNode(),
						(response.message as string) ||
							'Sessão não autenticada. Abra a credencial Telethon API e clique em Test para autenticar.',
						{ itemIndex: i },
					);
				}

				returnData.push({
					json: {
						...response,
						credential_id: credentialId,
					},
				});
			} catch (error) {
				if (error instanceof NodeOperationError) {
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
