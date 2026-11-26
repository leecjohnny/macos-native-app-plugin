import { join } from "node:path";
import { mail } from "../../../plugins/mail/src/plugin.ts";
import { photos } from "../../../plugins/photos/src/plugin.ts";
import { testMcpContract } from "../../../packages/testing/src/contracts/mcp.ts";
import { testCliContract } from "../../../packages/testing/src/contracts/cli.ts";
import { testSqlSandboxContract } from "../../../packages/testing/src/contracts/sql-sandbox.ts";
testCliContract(join(import.meta.dir, "../src/cli.ts"));
testMcpContract([mail, photos]);
testSqlSandboxContract();
