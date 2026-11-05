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

import { expect } from 'chai';
import { PassThrough } from 'stream';
import * as cp from 'child_process';
import { Deferred } from '@theia/core/lib/common/promise-util';
import { ILogger } from '@theia/core/lib/common/logger';
import { ProcessEnvironment } from '@theia/core/lib/node/process-environment';
import { HostedPluginClient } from '../../common/plugin-protocol.js';
import { LogPart, LogType } from '../../common/types.js';
import { HostedPluginProcess } from './hosted-plugin-process.js';

/**
 * The process with the fork replaced: it fails until {@link forkError} is cleared and then returns a child whose
 * message pipe is {@link pipe}.
 */
class TestHostedPluginProcess extends HostedPluginProcess {
    forkError: Error | undefined = new Error('fork failed');
    readonly pipe = new PassThrough();
    readonly errors: unknown[] = [];
    protected override readonly logger = {
        error: (...args: unknown[]) => { this.errors.push(args); }
    } as unknown as ILogger;
    protected override readonly processEnvironment: ProcessEnvironment;

    constructor(ready: Promise<void>) {
        super();
        this.processEnvironment = { ready };
    }

    protected override fork(): cp.ChildProcess {
        if (this.forkError) {
            throw this.forkError;
        }
        return { stdio: [undefined, undefined, undefined, undefined, this.pipe] } as unknown as cp.ChildProcess;
    }
}

describe('HostedPluginProcess', () => {

    it('reports a failing fork to the log and to the client and lets the host start again', async () => {
        const ready = new Deferred<void>();
        const process = new TestHostedPluginProcess(ready.promise);
        const logged: LogPart[] = [];
        process.setClient({ log: (logPart: LogPart) => { logged.push(logPart); } } as unknown as HostedPluginClient);

        const run = process.runPluginServer();
        process.onMessage('hosted-plugin', new Uint8Array([1, 2, 3]));
        ready.resolve();
        let error: unknown;
        await run.catch(e => { error = e; });
        expect(String(error)).to.contain('fork failed');
        expect(process.errors).to.have.length(1);
        expect(logged).to.have.length(1);
        expect(logged[0].type).to.equal(LogType.Error);
        expect(logged[0].data).to.contain('fork failed');

        // the next start does not deliver the messages that were queued for the failed one
        process.forkError = undefined;
        const received: Buffer[] = [];
        process.pipe.on('data', data => received.push(data));
        await process.runPluginServer();
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(received).to.deep.equal([]);
    });

    it('delivers the messages that arrive while it waits for the environment', async () => {
        const ready = new Deferred<void>();
        const process = new TestHostedPluginProcess(ready.promise);
        process.forkError = undefined;
        const received: Buffer[] = [];
        process.pipe.on('data', data => received.push(data));

        const run = process.runPluginServer();
        process.onMessage('hosted-plugin', new Uint8Array([1, 2, 3]));
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(received).to.deep.equal([]);

        ready.resolve();
        await run;
        await new Promise(resolve => setTimeout(resolve, 0));
        // the message is framed by the pipe, so only its end is the message
        const all = Buffer.concat(received);
        expect(all.length).to.be.greaterThan(3);
        expect([...all.subarray(all.length - 3)]).to.deep.equal([1, 2, 3]);
    });
});
