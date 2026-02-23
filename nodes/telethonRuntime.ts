import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

type EmitFn = (data: INodeExecutionData[][]) => void;

let pythonProcess: ReturnType<typeof spawn> | undefined;
const emitters = new Set<EmitFn>();

const DEFAULT_BASE_URL = 'http://127.0.0.1:7132';
const IMPORT_CHECK = 'import flask,telethon';
const HEALTH_CHECK_SCRIPT =
	"import sys,urllib.request,json,pathlib; data=json.load(urllib.request.urlopen(sys.argv[1] + '/health', timeout=0.7)); expected=str(pathlib.Path(sys.argv[2]).resolve()); ok=(data.get('status')=='ok' and data.get('service')=='n8n-nodes-telegram' and data.get('sessions_dir')==expected); print('ok' if ok else 'mismatch')";
const HEALTH_PING_SCRIPT = "import sys,urllib.request; urllib.request.urlopen(sys.argv[1] + '/health', timeout=0.7); print('up')";

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

function getVenvPython(root: string): string {
	return path.join(root, '.venv/bin/python');
}

function getPythonBin(root: string): string {
	const envPython = process.env.TELETHON_PYTHON_PATH;
	if (envPython) {
		return envPython;
	}

	const venvPython = getVenvPython(root);
	return fs.existsSync(venvPython) ? venvPython : 'python3';
}

function canImportDeps(pythonBin: string, root: string): boolean {
	const result = runCommand(pythonBin, ['-c', IMPORT_CHECK], root);
	return result.status === 0;
}

function installDependencies(pythonBin: string, root: string): boolean {
	const install = runCommand(pythonBin, ['-m', 'pip', 'install', '-r', 'python/requirements.txt'], root);
	if (install.status === 0) {
		return true;
	}

	console.error('[Telethon] Falha ao instalar dependências Python automaticamente.');
	if (install.stderr) {
		console.error(install.stderr);
	}
	return false;
}

function ensureVenv(root: string): boolean {
	const venvPython = getVenvPython(root);
	if (fs.existsSync(venvPython)) {
		return true;
	}

	const venvCreate = runCommand('python3', ['-m', 'venv', '.venv'], root);
	if (venvCreate.status === 0) {
		return true;
	}

	console.error('[Telethon] Falha ao criar .venv automaticamente.');
	if (venvCreate.stderr) {
		console.error(venvCreate.stderr);
	}
	return false;
}

function ensurePythonEnvironment(root: string): string {
	let pythonBin = getPythonBin(root);
	const autoInstall = process.env.TELETHON_AUTO_INSTALL !== 'false';

	if (!canImportDeps(pythonBin, root) && autoInstall) {
		const envPython = process.env.TELETHON_PYTHON_PATH;
		if (!envPython && ensureVenv(root)) {
			pythonBin = getVenvPython(root);
		}

		installDependencies(pythonBin, root);
	}

	if (!canImportDeps(pythonBin, root)) {
		throw new Error(
			`Python sem dependências (${pythonBin}). Instale: ${pythonBin} -m pip install -r python/requirements.txt`,
		);
	}

	return pythonBin;
}

function handleStdoutLine(line: string): IDataObject | undefined {
	if (!line.trim()) {
		return undefined;
	}

	try {
		return JSON.parse(line) as IDataObject;
	} catch {
		return undefined;
	}
}

function getPortFromBaseUrl(baseUrl: string): string {
	try {
		const parsed = new URL(baseUrl);
		return parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
	} catch {
		return '7132';
	}
}

function isServiceHealthy(baseUrl: string, pythonBin: string, root: string): boolean {
	const expectedSessionsDir = path.join(root, 'sessions');
	const health = runCommand(pythonBin, ['-c', HEALTH_CHECK_SCRIPT, baseUrl, expectedSessionsDir], root);
	return health.status === 0 && health.stdout.trim() === 'ok';
}

function isAnyServiceUp(baseUrl: string, pythonBin: string, root: string): boolean {
	const ping = runCommand(pythonBin, ['-c', HEALTH_PING_SCRIPT, baseUrl], root);
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

export function ensurePythonService(options?: { emit?: EmitFn; baseUrl?: string }): void {
	const emit = options?.emit;
	if (emit !== undefined) {
		emitters.add(emit);
	}

	if (pythonProcess) {
		return;
	}

	const root = projectRoot();
	const pythonBin = ensurePythonEnvironment(root);
	const pythonPath = path.join(root, 'python/app.py');
	const baseUrl = options?.baseUrl ?? getTelethonBaseUrl();
	const telethonPort = getPortFromBaseUrl(baseUrl);

	if (isServiceHealthy(baseUrl, pythonBin, root)) {
		return;
	}

	if (isAnyServiceUp(baseUrl, pythonBin, root)) {
		throw new Error(
			`Ja existe um servico na porta ${telethonPort}, mas nao pertence a esta instancia do node (sessions diferentes). Encerre o processo antigo antes de testar.`,
		);
	}

	pythonProcess = spawn(pythonBin, [pythonPath], {
		cwd: root,
		env: {
			...process.env,
			TELETHON_PORT: telethonPort,
		},
	});

	pythonProcess.on('error', (error) => {
		console.error(`[Telethon] Falha ao iniciar Python (${pythonBin})`, error);
		pythonProcess = undefined;
	});

	pythonProcess.on('exit', () => {
		pythonProcess = undefined;
	});

	if (pythonProcess.stdout) {
		pythonProcess.stdout.on('data', (data: Buffer) => {
			const lines = data.toString().split('\n');
			for (const line of lines) {
				const parsed = handleStdoutLine(line);
				if (parsed?.type === 'event') {
					for (const currentEmit of emitters) {
						currentEmit([[{ json: parsed }]]);
					}
				}
			}
		});
	}

	if (pythonProcess.stderr) {
		pythonProcess.stderr.on('data', (data: Buffer) => {
			const msg = data.toString();
			console.error(msg);
			if (msg.includes('Address already in use')) {
				console.warn(`[Telethon] Porta ${telethonPort} já em uso. Usando serviço já existente.`);
			}
		});
	}
}
