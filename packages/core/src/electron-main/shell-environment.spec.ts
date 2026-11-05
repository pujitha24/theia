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
import { ShellEnvironmentImpl } from './shell-environment.js';

/**
 * The service with a short timeout and the login shells replaced by a script, so that the tests run without
 * spawning a shell.
 */
class TestShellEnvironment extends ShellEnvironmentImpl {
    protected override readonly timeoutMs = 50;
    /** The shells that were started, in order. */
    readonly started: string[] = [];
    /** The shells that were aborted before they finished. */
    readonly aborted: string[] = [];

    constructor(protected readonly shells: Record<string, (signal: AbortSignal) => Promise<string>>) {
        super();
    }

    override parseShellPath(output: string): string | undefined {
        return super.parseShellPath(output);
    }

    resolve(): Promise<string | undefined> {
        return this.withTimeout(signal => this.resolveShellPath(signal));
    }

    protected override getDefaultShell(): string {
        return '/bin/default';
    }

    protected override runLoginShell(shell: string, signal: AbortSignal): Promise<string> {
        this.started.push(shell);
        const run = this.shells[shell] ?? (() => Promise.reject(new Error(`${shell} is not available`)));
        return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => {
                this.aborted.push(shell);
                reject(signal.reason);
            });
            run(signal).then(resolve, reject);
        });
    }
}

describe('ShellEnvironmentImpl', () => {

    const delimiter = '_THEIA_SHELL_ENV_DELIMITER_';
    const parse = (output: string) => new TestShellEnvironment({}).parseShellPath(output);

    describe('parseShellPath', () => {

        it('reads the PATH between the delimiters, ignoring what the dotfiles print around them', () => {
            const output = `Welcome!\nPATH=/not/this\n${delimiter}HOME=/Users/me\nPATH=/opt/bin:/usr/bin\nSHELL=/bin/zsh\n${delimiter}bye`;
            expect(parse(output)).to.equal('/opt/bin:/usr/bin');
        });

        it('keeps equals signs in the value', () => {
            expect(parse(`${delimiter}PATH=/a=b:/usr/bin\n${delimiter}`)).to.equal('/a=b:/usr/bin');
        });

        it('does not take a variable whose name ends in PATH', () => {
            expect(parse(`${delimiter}MANPATH=/usr/share/man\nPATH=/usr/bin\n${delimiter}`)).to.equal('/usr/bin');
        });

        it('strips ANSI escape sequences', () => {
            expect(parse(`${delimiter}\u001B[0mPATH=/usr/bin\u001B]0;title\u0007\n${delimiter}`)).to.equal('/usr/bin');
        });

        it('returns undefined when the environment has no PATH or the delimiter is missing', () => {
            expect(parse(`${delimiter}HOME=/Users/me\n${delimiter}`)).to.be.undefined;
            expect(parse('PATH=/usr/bin\n')).to.be.undefined;
        });
    });

    describe('resolveShellPath', () => {

        const env = (path: string) => `${delimiter}PATH=${path}\n${delimiter}`;

        it('takes the PATH from the default shell', async () => {
            const environment = new TestShellEnvironment({ '/bin/default': async () => env('/opt/bin') });
            expect(await environment.resolve()).to.equal('/opt/bin');
            expect(environment.started).to.deep.equal(['/bin/default']);
        });

        it('falls back to other shells when the default shell fails', async () => {
            const environment = new TestShellEnvironment({ '/bin/bash': async () => env('/usr/bin') });
            expect(await environment.resolve()).to.equal('/usr/bin');
            expect(environment.started).to.deep.equal(['/bin/default', '/bin/zsh', '/bin/bash']);
        });

        it('aborts a shell that hangs and does not start the other shells after the timeout', async () => {
            const environment = new TestShellEnvironment({ '/bin/default': () => new Promise(() => { /* never */ }) });
            let error: unknown;
            await environment.resolve().catch(e => { error = e; });
            expect(String(error)).to.contain('did not respond');
            expect(environment.aborted).to.deep.equal(['/bin/default']);
            expect(environment.started).to.deep.equal(['/bin/default']);
        });
    });
});
