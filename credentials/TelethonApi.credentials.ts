import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';
import { ensurePythonService } from '../nodes/telethonRuntime';

const bootstrapBaseUrl = process.env.TELETHON_BASE_URL ?? 'http://127.0.0.1:7132';

try {
	ensurePythonService({ baseUrl: bootstrapBaseUrl });
} catch (error) {
	console.error('[Telethon] Falha ao subir Python no carregamento da credencial.', error);
}

export class TelethonApi implements ICredentialType {
	name = 'telethonApi';

	displayName = 'Telethon API Credentials';

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'http://127.0.0.1:7132',
			url: '/session/start',
			method: 'POST',
			body: {
				credential_id: '={{"telethon-" + $credentials.apiId + "-" + String($credentials.phone).replace(/\\s+/g, "")}}',
				api_id: '={{$credentials.apiId}}',
				api_hash: '={{$credentials.apiHash}}',
				phone: '={{$credentials.phone}}',
				code: '={{$credentials.code}}',
				password: '={{$credentials.password}}',
			},
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'status',
					value: 'code_required',
					message:
						'Codigo enviado. Informe o code recebido no Telegram.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'status',
					value: '2fa_required',
					message:
						'Conta com 2FA. Informe o campo password.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'status',
					value: 'invalid_code',
					message:
						'Codigo invalido.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'status',
					value: 'invalid_2fa',
					message:
						'Senha 2FA invalida.',
				},
			},
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'status',
					value: 'expired_code',
					message:
						'Codigo expirado. Solicite um novo code.',
				},
			},
		],
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API ID',
			name: 'apiId',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
		},
		{
			displayName: 'API Hash',
			name: 'apiHash',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
		},
		{
			displayName: 'Phone',
			name: 'phone',
			type: 'string',
			default: '',
			required: true,
			placeholder: '5511999999999',
		},
		{
			displayName: 'Code',
			name: 'code',
			type: 'string',
			default: '',
			description: 'Leave empty on first test. Fill with the Telegram code and test again.',
		},
		{
			displayName: '2FA Password',
			name: 'password',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description: 'Only required for accounts with two-step verification.',
		},
	];
}
