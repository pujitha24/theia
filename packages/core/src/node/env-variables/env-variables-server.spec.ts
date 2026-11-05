// *****************************************************************************
// Copyright (C) 2026 STMicroelectronics and others.
//
// This program and the accompanying materials are made available under the
// terms of the Eclipse Public License v. 2.0 which is available at
// http://www.eclipse.org/legal/epl-2.0.
//
// This Source Code may also be made available under the following Secondary
// Licenses when the conditions for such availability set forth in the Eclipse
// Public License v. 2.0 are satisfied: GNU General Public License, version 2
// with the GNU Classpath Exception which is available at
// https://www.gnu.org/software/classpath/license.html.
//
// SPDX-License-Identifier: EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0
// *****************************************************************************

import * as chai from 'chai';
import { Deferred } from '../../common/promise-util.js';
import { ILogger } from '../../common/logger.js';
import { ProcessEnvironment } from '../process-environment.js';
import { EnvVariablesServerImpl } from './env-variables-server.js';

const expect = chai.expect;

/**
 * The server with the environment of the process completed on demand and the logger replaced.
 */
class TestEnvVariablesServer extends EnvVariablesServerImpl {
    readonly ready = new Deferred<void>();
    protected override readonly logger = { info: () => { } } as unknown as ILogger;
    protected override readonly processEnvironment: ProcessEnvironment = { ready: this.ready.promise };

    get snapshotKeys(): string[] {
        return Object.keys(this.envs);
    }
}

describe('EnvVariablesServerImpl', () => {

    const variable = 'THEIA_ENV_VARIABLES_SERVER_SPEC';
    const stale = 'THEIA_ENV_VARIABLES_SERVER_SPEC_STALE';
    let configDir: string | undefined;

    beforeEach(() => {
        configDir = process.env.THEIA_CONFIG_DIR;
        process.env.THEIA_CONFIG_DIR = '/tmp/theia-env-variables-server-spec';
        delete process.env[variable];
        process.env[stale] = 'set before the server exists';
    });

    afterEach(() => {
        if (configDir === undefined) {
            delete process.env.THEIA_CONFIG_DIR;
        } else {
            process.env.THEIA_CONFIG_DIR = configDir;
        }
        delete process.env[variable];
        delete process.env[stale];
    });

    it('takes a snapshot of the environment in the constructor', () => {
        const server = new TestEnvVariablesServer();
        expect(server.snapshotKeys).to.contain(stale);
    });

    it('answers with the complete environment once it is ready', async () => {
        const server = new TestEnvVariablesServer();
        let value: unknown;
        const pending = server.getValue(variable).then(v => { value = v; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(value).to.equal(undefined);

        process.env[variable] = 'from the login shell';
        delete process.env[stale];
        server.ready.resolve();
        await pending;
        expect(value).to.deep.equal({ name: variable, value: 'from the login shell' });
        // the entries of the first snapshot that are gone are dropped
        expect(await server.getValue(stale)).to.equal(undefined);
        expect((await server.getVariables()).map(v => v.name)).to.contain(variable).and.not.to.contain(stale);
    });
});
