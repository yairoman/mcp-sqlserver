import sql from 'mssql';
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenvConfig({ path: resolve(__dirname, '.env'), quiet: true });

const config = {
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_HOST,
    port: Number(process.env.MSSQL_PORT || 1433),
    database: process.env.MSSQL_DATABASE || 'master',
    connectionTimeout: Number(process.env.MSSQL_CONNECTION_TIMEOUT || 15000),
    requestTimeout: Number(process.env.MSSQL_QUERY_TIMEOUT || 30000),
    options: {
        encrypt: process.env.MSSQL_ENCRYPT === 'true',
        trustServerCertificate: process.env.MSSQL_TRUST_SERVER_CERTIFICATE === 'true',
        readOnlyIntent: process.env.MSSQL_READ_ONLY !== 'false'
    }
};

function validateConfig() {
    const missing = [];
    if (!config.user) missing.push('MSSQL_USER');
    if (!config.password) missing.push('MSSQL_PASSWORD');
    if (!config.server) missing.push('MSSQL_HOST');

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

async function main() {
    try {
        validateConfig();
        await sql.connect(config);
        const query = process.argv[2] || "SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE'";
        const result = await sql.query(query);
        console.log(JSON.stringify(result.recordset, null, 2));
    } catch (err) {
        console.error(err);
    } finally {
        await sql.close();
    }
}

main();
