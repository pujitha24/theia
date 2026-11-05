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
import { Deferred } from '@theia/core/lib/common/promise-util';
import { ProcessEnvironment } from '@theia/core/lib/node/process-environment';
import { ShellExecutionServerImpl } from './shell-execution-server-impl.js';

describe('ShellExecutionServerImpl', () => {

    function createServer(): { server: ShellExecutionServerImpl, ready: Deferred<void> } {
        const ready = new Deferred<void>();
        const server = new ShellExecutionServerImpl();
        (server as unknown as { processEnvironment: ProcessEnvironment }).processEnvironment = { ready: ready.promise };
        return { server, ready };
    }

    it('cancels an execution that is still waiting for the environment of the backend', async () => {
        const { server, ready } = createServer();
        const result = server.execute({ command: 'echo should not run', executionId: 'pending' });
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(await server.cancel('pending')).to.equal(true);
        ready.resolve();

        const { success, canceled, error } = await result;
        expect(success).to.equal(false);
        expect(canceled).to.equal(true);
        expect(error).to.equal('Command canceled by user');
        // the cancellation is consumed
        expect(await server.cancel('pending')).to.equal(false);
    });

    it('does not cancel an execution it does not know', async () => {
        const { server } = createServer();
        expect(await server.cancel('unknown')).to.equal(false);
    });
});
