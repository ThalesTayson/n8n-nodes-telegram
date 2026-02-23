import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';

import { NodeOperationError } from 'n8n-workflow';
import { ensurePythonService, getCredentialId, getTelethonBaseUrl } from './telethonRuntime';

export class TelethonTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Telethon Trigger',
		name: 'telethonTrigger',
		icon: 'file:telegram.svg',
		group: ['trigger'],
		version: 1,
		description: 'Listen for Telegram messages via Telethon service (webhook mode)',
		defaults: {
			name: 'Telethon Trigger',
		},
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: 'telethonApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'telethon',
			},
		],
		properties: [],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return false;
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const credentials = (await this.getCredentials('telethonApi')) as IDataObject;
				const baseUrl = getTelethonBaseUrl(credentials);
				ensurePythonService({ baseUrl });
				const sessionId = getCredentialId(credentials);
				const webhookUrl = this.getNodeWebhookUrl('default');

				if (!webhookUrl) {
					throw new NodeOperationError(
						this.getNode(),
						'Nao foi possivel resolver a URL do webhook para registrar o listener.',
					);
				}

				const response = await this.helpers.httpRequest({
					method: 'POST',
					url: `${baseUrl}/${sessionId}/listener/register`,
					body: {
						webhook: webhookUrl,
					},
					json: true,
				});

				if (response?.error === 'session_not_found') {
					throw new NodeOperationError(
						this.getNode(),
						'Sessão não encontrada. Abra a credencial Telethon API e clique em "Test" para autenticar.',
					);
				}

				if (response?.error === 'not_authenticated') {
					throw new NodeOperationError(
						this.getNode(),
						'Sessão encontrada, mas não autenticada. Refaça o Test da credencial com código/2FA.',
					);
				}

				if (
					response?.status !== 'listening' &&
					response?.status !== 'already_listening'
				) {
					throw new NodeOperationError(
						this.getNode(),
						`Falha ao registrar listener: ${JSON.stringify(response)}`,
					);
				}

				return true;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const credentials = (await this.getCredentials('telethonApi')) as IDataObject;
				const baseUrl = getTelethonBaseUrl(credentials);
				const sessionId = getCredentialId(credentials);

				try {
					await this.helpers.httpRequest({
						method: 'POST',
						url: `${baseUrl}/${sessionId}/listener/unregister`,
						json: true,
					});
				} catch {
					// Não derruba desativação se falhar ao remover
				}

				return true;
			},
		},
	};

	// 🔥 Executado quando o Telethon fizer POST no webhook
	async webhook(
		this: IWebhookFunctions,
	): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		const headers = this.getHeaderData();

		const normalizedBody =
			body && typeof body === 'object' && !Array.isArray(body)
				? (body as IDataObject)
				: ({ payload: body } as IDataObject);

		// Garante que o conteúdo em _meta seja serializável no execution data.
		const safeHeaders = JSON.parse(JSON.stringify(headers ?? {})) as IDataObject;

		return {
			workflowData: [
				[
					{
						json: {
							...normalizedBody,
							_meta: {
								received_at: new Date().toISOString(),
							},
						},
					},
				],
			],
		};
	}
}
