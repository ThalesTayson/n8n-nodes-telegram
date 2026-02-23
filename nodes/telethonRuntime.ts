import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

type EmitFn = (data: INodeExecutionData[][]) => void;

let nodeServiceProcess: ReturnType<typeof spawn> | undefined;
const emitters = new Set<EmitFn>();

const DEFAULT_BASE_URL = 'http://127.0.0.1:7132';
const HEALTH_CHECK_SCRIPT =
	"fetch(process.argv[1] + '/health').then(async (r)=>{if(!r.ok){process.exit(1);return;} const d=await r.json(); const ok=(d?.status==='ok' && d?.service==='n8n-nodes-telegram-node'); process.stdout.write(ok ? 'ok' : 'mismatch');}).catch(()=>process.exit(1));";
const HEALTH_PING_SCRIPT =
	"fetch(process.argv[1] + '/health').then((r)=>{if(!r.ok){process.exit(1);return;} process.stdout.write('up');}).catch(()=>process.exit(1));";

function runCommand(cmd: string, args: string[], cwd: string) {
	return spawnSync(cmd, args, {
		cwd,
		encoding: 'utf8',
		stdio: 'pipe',
	});
}

function projectRoot(): string {
	return path.resolve(__dirname, '../..');
}

function getNodeBin(): string {
	return process.env.TELETHON_NODE_PATH || 'node';
}

function getServiceEntrypoint(root: string): string {
	return path.join(root, 'telethon-node-service/server.js');
}

function hasRequiredFiles(root: string): boolean {
	const servicePath = getServiceEntrypoint(root);
	return fs.existsSync(servicePath);
}

function canRunNode(nodeBin: string, root: string): boolean {
	const result = runCommand(nodeBin, ['-v'], root);
	return result.status === 0;
}

function getPortFromBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
	} catch {
		return '7132';
	}
}

function isServiceHealthy(baseUrl: string, nodeBin: string, root: string): boolean {
	const health = runCommand(nodeBin, ['-e', HEALTH_CHECK_SCRIPT, baseUrl], root);
	return health.status === 0 && health.stdout.trim() === 'ok';
}

function isAnyServiceUp(baseUrl: string, nodeBin: string, root: string): boolean {
	const ping = runCommand(nodeBin, ['-e', HEALTH_PING_SCRIPT, baseUrl], root);
	return ping.status === 0 && ping.stdout.trim() === 'up';
}

export function getTelethonBaseUrl(credentials?: IDataObject): string {
	const baseUrlFromCredential = credentials?.baseUrl;
	if (typeof baseUrlFromCredential === 'string' && baseUrlFromCredential.trim()) {
		return baseUrlFromCredential.trim();
	}
	return process.env.TELETHON_BASE_URL ?? DEFAULT_BASE_URL;
}

export function getCredentialId(credentials: IDataObject): string {
	const apiId = String(credentials.apiId ?? '');
	const phone = String(credentials.phone ?? '').replace(/\s+/g, '');
	return `telethon-${apiId}-${phone}`;
}

// Mantido por compatibilidade com os nodes existentes.
export function ensurePythonService(options?: { emit?: EmitFn; baseUrl?: string }): void {
	const emit = options?.emit;
	if (emit !== undefined) {
		emitters.add(emit);
	}

	if (nodeServiceProcess) {
		return;
	}

	const root = projectRoot();
	const nodeBin = getNodeBin();
	const servicePath = getServiceEntrypoint(root);
	const baseUrl = options?.baseUrl ?? getTelethonBaseUrl();
	const telethonPort = getPortFromBaseUrl(baseUrl);

	if (!hasRequiredFiles(root)) {
		throw new Error(
			`Servico Node nao encontrado em ${servicePath}. Verifique a pasta telethon-node-service.`,
		);
	}

	if (!canRunNode(nodeBin, root)) {
		throw new Error(`Nao foi possivel executar Node.js com o binario "${nodeBin}".`);
	}

	if (isServiceHealthy(baseUrl, nodeBin, root)) {
		return;
	}

	if (isAnyServiceUp(baseUrl, nodeBin, root)) {
		throw new Error(
			`Ja existe um servico na porta ${telethonPort}, mas nao pertence a esta instancia do node. Encerre o processo antigo antes de testar.`,
		);
	}

	nodeServiceProcess = spawn(nodeBin, [servicePath], {
		cwd: root,
		env: {
			...process.env,
			PORT: telethonPort,
		},
	});

	nodeServiceProcess.on('error', (error) => {
		console.error(`[Telethon] Falha ao iniciar servico Node (${nodeBin})`, error);
		nodeServiceProcess = undefined;
	});

	nodeServiceProcess.on('exit', () => {
		nodeServiceProcess = undefined;
	});

	if (nodeServiceProcess.stderr) {
		nodeServiceProcess.stderr.on('data', (data: Buffer) => {
			const msg = data.toString();
			console.error(msg);
			if (msg.includes('EADDRINUSE')) {
				console.warn(`[Telethon] Porta ${telethonPort} ja em uso. Usando servico ja existente.`);
			}
		});
	}
}
