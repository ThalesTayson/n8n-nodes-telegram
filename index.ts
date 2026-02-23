import { ensurePythonService } from './nodes/telethonRuntime';

const bootstrapEnabled = process.env.TELETHON_BOOTSTRAP_ON_LOAD !== 'false';

if (bootstrapEnabled) {
	try {
		ensurePythonService();
	} catch (error) {
		console.error('[Telethon] Falha no bootstrap automático do serviço Python.', error);
	}
}

export {};
