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

import { execFile } from 'child_process';
import * as os from 'os';
import { inject, injectable } from 'inversify';
import { Stopwatch } from '../common/performance/index.js';

export const ShellEnvironment = Symbol('ShellEnvironment');

/** Separates the output of the `env` command from whatever the user's dotfiles print. */
const ENV_DELIMITER = '_THEIA_SHELL_ENV_DELIMITER_';

const ANSI_ESCAPE = new RegExp([
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))'
].join('|'), 'g');

/**
 * Resolves the `PATH` of the user's login shell and applies it to the environment of the Electron main process.
 *
 * GUI applications on macOS and Linux do not inherit the `PATH` defined in the user's dotfiles
 * (`.zshrc`, `.bash_profile`, ...), so without this, the processes that Theia spawns (the backend and,
 * through it, terminals, tasks and language servers) would not find the user's tools.
 * See https://github.com/electron/electron/issues/550#issuecomment-162037357
 * and https://github.com/eclipse-theia/theia/pull/3534#issuecomment-439689082.
 */
export interface ShellEnvironment {
    /**
     * Resolve the `PATH` of the login shell and apply it to `process.env`.
     *
     * The resolution runs an interactive login shell, which can take more than a second depending on the
     * user's dotfiles, so it is started once and the same promise is returned on subsequent calls. The promise
     * never rejects: if the shell cannot be run or does not respond in time, a warning is logged and the
     * environment is left as it is.
     */
    apply(): Promise<void>;
}

@injectable()
export class ShellEnvironmentImpl implements ShellEnvironment {

    @inject(Stopwatch)
    protected readonly stopwatch: Stopwatch;

    /** How long to wait for the login shell, in milliseconds, before giving up. */
    protected readonly timeoutMs: number = 10_000;

    protected applied: Promise<void> | undefined;

    apply(): Promise<void> {
        if (!this.applied) {
            this.applied = this.stopwatch.startAsync('electron-main-shell-environment', 'Resolving the shell environment', () => this.doApply())
                .catch(error => console.warn('Could not resolve the PATH of the login shell, child processes may not find the user\'s tools:', error));
        }
        return this.applied;
    }

    protected async doApply(): Promise<void> {
        if (process.platform === 'win32') {
            return;
        }
        const resolved = await this.withTimeout(signal => this.resolveShellPath(signal));
        process.env.PATH = resolved || this.getFallbackPath();
    }

    /**
     * Runs the user's login shell, falling back to other POSIX shells if it fails, and returns the `PATH` that
     * its environment defines. The `signal` aborts the shell that is running and the fallback to other shells.
     *
     * This does what the `shell-path` package does, without its dependency on `execa`: `execa` installs
     * `signal-exit` listeners while the shell runs, and when it removes them, Node resets SIGINT, SIGTERM and
     * the other signals to their default action, which discards the handlers that Chromium installed to shut the
     * application down gracefully and to report crashes.
     */
    protected async resolveShellPath(signal: AbortSignal): Promise<string | undefined> {
        const defaultShell = this.getDefaultShell();
        const shells = [defaultShell, ...['/bin/zsh', '/bin/bash'].filter(shell => shell !== defaultShell)];
        let lastError: unknown;
        for (const shell of shells) {
            if (signal.aborted) {
                throw signal.reason;
            }
            try {
                return this.parseShellPath(await this.runLoginShell(shell, signal));
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError;
    }

    protected getDefaultShell(): string {
        try {
            const { shell } = os.userInfo();
            if (shell) {
                return shell;
            }
        } catch {
            // Fall back to the environment
        }
        return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    }

    protected runLoginShell(shell: string, signal: AbortSignal): Promise<string> {
        // The `command` builtin avoids aliases and functions named `env`.
        const script = `echo -n "${ENV_DELIMITER}"; command env; echo -n "${ENV_DELIMITER}"; exit`;
        const env = {
            ...process.env,
            // Keep Oh My Zsh from blocking on its auto-update and its tmux plugin from starting tmux.
            DISABLE_AUTO_UPDATE: 'true',
            ZSH_TMUX_AUTOSTARTED: 'true',
            ZSH_TMUX_AUTOSTART: 'false'
        };
        return new Promise((resolve, reject) => {
            // An interactive shell ignores SIGTERM, so a shell that hangs is killed with SIGKILL when the signal aborts.
            execFile(shell, ['-ilc', script], { env, signal, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout);
                }
            });
        });
    }

    /**
     * Extracts the `PATH` from the output of the login shell command of {@link runLoginShell}, or `undefined`
     * if the output does not define one.
     */
    protected parseShellPath(output: string): string | undefined {
        const env = output.split(ENV_DELIMITER)[1];
        if (env === undefined) {
            return undefined;
        }
        for (const line of env.replace(ANSI_ESCAPE, '').split('\n')) {
            if (line.startsWith('PATH=')) {
                return line.substring('PATH='.length);
            }
        }
        return undefined;
    }

    /**
     * Runs the `task` with a signal that aborts after {@link timeoutMs}, after which the result is an error.
     */
    protected async withTimeout<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`The login shell did not respond within ${this.timeoutMs} ms`)), this.timeoutMs);
        try {
            return await task(controller.signal);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * The `PATH` to apply when the login shell does not define one, as `fix-path` does.
     */
    protected getFallbackPath(): string {
        return ['./node_modules/.bin', '/.nodebrew/current/bin', '/usr/local/bin', process.env.PATH].join(':');
    }
}
