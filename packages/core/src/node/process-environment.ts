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

import { inject, injectable, named, postConstruct } from 'inversify';
import { ILogger } from '../common/logger.js';
import { Deferred } from '../common/promise-util.js';
import { isObject } from '../common/types.js';

/**
 * Name of the environment variable with which the parent process announces that it will complete
 * the environment of the backend later, see {@link ProcessEnvironment}.
 */
export const PROCESS_ENVIRONMENT_PENDING_VARIABLE = 'THEIA_PROCESS_ENVIRONMENT';

/**
 * The IPC message with which the parent process completes the environment of the backend, see {@link ProcessEnvironment}.
 */
export interface ProcessEnvironmentMessage {
    readonly type: typeof ProcessEnvironmentMessage.TYPE;
    /** The variables to apply to the environment of the backend. */
    readonly env: NodeJS.ProcessEnv;
}
export namespace ProcessEnvironmentMessage {
    export const TYPE = 'theia-process-environment';
    export function is(message: unknown): message is ProcessEnvironmentMessage {
        return isObject<ProcessEnvironmentMessage>(message) && message.type === TYPE && isObject(message.env);
    }
}

export const ProcessEnvironment = Symbol('ProcessEnvironment');

/**
 * Tells when the environment of the backend process, `process.env`, is complete.
 *
 * An Electron application resolves the `PATH` of the user's login shell, which GUI applications on macOS and
 * Linux do not inherit, in its main process. Running the login shell can take seconds, so the backend is forked
 * before the `PATH` is known, with {@link PROCESS_ENVIRONMENT_PENDING_VARIABLE} set, and the main process sends
 * it over IPC once it is. Until then `process.env` is the environment of the GUI application, in which the user's
 * tools may be missing. Code that spawns child processes which should find the user's tools, such as terminals,
 * tasks and the plugin host, awaits {@link ready} before spawning.
 */
export interface ProcessEnvironment {
    /**
     * Resolves once `process.env` carries the environment of the user's login shell, or right away when nothing
     * is pending, for example in a browser deployment or on Windows. Never rejects: if the parent process does
     * not send it in time, a warning is logged and the environment is left as it is.
     */
    readonly ready: Promise<void>;
}

@injectable()
export class ProcessEnvironmentImpl implements ProcessEnvironment {

    @inject(ILogger) @named('core:ProcessEnvironmentImpl')
    protected readonly logger: ILogger;

    /** How long to wait for the parent process, in milliseconds, before giving up. */
    protected readonly timeoutMs: number = 15_000;

    protected readonly readyDeferred = new Deferred<void>();
    readonly ready = this.readyDeferred.promise;

    /**
     * The service waits for the environment as soon as it exists. It is bound as a backend application contribution,
     * without hooks, only so that it exists from the start of the backend rather than at the first injection.
     */
    @postConstruct()
    protected init(): void {
        this.awaitEnvironment();
    }

    /**
     * Wait for the environment from the parent process, if it announced that the environment is pending.
     */
    protected awaitEnvironment(): void {
        const pending = process.env[PROCESS_ENVIRONMENT_PENDING_VARIABLE] === 'pending';
        // The announcement is for this process only: child processes must not wait for an environment of their own.
        delete process.env[PROCESS_ENVIRONMENT_PENDING_VARIABLE];
        if (!pending || typeof process.send !== 'function') {
            this.readyDeferred.resolve();
            return;
        }
        const timer = setTimeout(() => {
            process.off('message', listener);
            this.logger.warn(`The parent process did not provide the environment within ${this.timeoutMs} ms, child processes may not find the user's tools.`);
            this.readyDeferred.resolve();
        }, this.timeoutMs);
        const listener = (message: unknown) => {
            if (ProcessEnvironmentMessage.is(message)) {
                process.off('message', listener);
                clearTimeout(timer);
                this.apply(message.env);
                this.readyDeferred.resolve();
            }
        };
        // Node holds IPC messages that arrive before the first 'message' listener is attached, so the message of the
        // parent is not lost while the backend starts up, as long as nothing else attaches a listener earlier.
        process.on('message', listener);
    }

    protected apply(env: NodeJS.ProcessEnv): void {
        Object.assign(process.env, env);
    }
}
