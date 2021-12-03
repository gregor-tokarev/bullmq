import * as fs from 'fs';
import { Redis } from 'ioredis';
import * as path from 'path';
import { v4 } from 'uuid';
import {
  Processor,
  WorkerOptions,
  GetNextJobOptions,
  RedisClient,
} from '../interfaces';
import {
  clientCommandMessageReg,
  delay,
  DELAY_TIME_1,
  isNotConnectionError,
  isRedisInstance,
} from '../utils';
import { QueueBase } from './queue-base';
import { Repeat } from './repeat';
import { ChildPool } from './child-pool';
import { Job, JobJsonRaw } from './job';
import { RedisConnection } from './redis-connection';
import sandbox from './sandbox';
import { Scripts } from './scripts';
import { TimerManager } from './timer-manager';

// note: sandboxed processors would also like to define concurrency per process
// for better resource utilization.

export interface WorkerDeclaration {
  /**
   * Listen to 'active' event.
   *
   * This event is triggered when a job enters the 'active' state.
   *
   * @param event -
   */
  on(event: 'active', listener: (job: Job, prev: string) => void): this;

  /**
   * Listen to 'completed' event.
   *
   * This event is triggered when a job has successfully completed.
   *
   * @param event -
   */
  on(event: 'completed', listener: (job: Job) => void): this;

  /**
   * Listen to 'drained' event.
   *
   * This event is triggered when the queue has drained the waiting list.
   * Note that there could still be delayed jobs waiting their timers to expire
   * and this event will still be triggered as long as the waiting list has emptied.
   *
   * @param event -
   */
  on(event: 'drained', listener: () => void): this;

  /**
   * Listen to 'error' event.
   *
   * This event is triggered when an error is throw.
   *
   * @param event -
   */
  on(event: 'error', listener: (failedReason: Error) => void): this;

  /**
   * Listen to 'failed' event.
   *
   * This event is triggered when a job has thrown an exception.
   *
   * @param event -
   */
  on(event: 'failed', listener: (job: Job, error: Error) => void): this;

  /**
   * Listen to 'progress' event.
   *
   * This event is triggered when a job updates it progress, i.e. the
   * Job##updateProgress() method is called. This is useful to notify
   * progress or any other data from within a processor to the rest of the
   * world.
   *
   * @param event -
   */
  on(
    event: 'progress',
    listener: (job: Job, progress: number | object) => void,
  ): this;
  on(event: string, listener: Function): this;
}

/**
 *
 * This class represents a worker that is able to process jobs from the queue.
 * As soon as the class is instantiated it will start processing jobs.
 *
 */
export class Worker<
    DataType = any,
    ResultType = any,
    NameType extends string = string,
  >
  extends QueueBase
  implements WorkerDeclaration
{
  opts: WorkerOptions;

  private drained: boolean;
  private waiting = false;
  private running = false;
  protected processFn: Processor<DataType, ResultType, NameType>;

  private resumeWorker: () => void;
  protected paused: Promise<void>;
  private _repeat: Repeat;
  private childPool: ChildPool;
  protected timerManager: TimerManager;

  private blockingConnection: RedisConnection;

  private processing: Map<
    Promise<Job<DataType, ResultType, NameType> | string>,
    string
  >;
  constructor(
    name: string,
    processor?: string | Processor<DataType, ResultType, NameType>,
    opts: WorkerOptions = {},
    Connection?: typeof RedisConnection,
  ) {
    super(
      name,
      { ...opts, sharedConnection: isRedisInstance(opts.connection) },
      Connection,
    );

    this.opts = {
      drainDelay: 5,
      concurrency: 1,
      lockDuration: 30000,
      runRetryDelay: 15000,
      autorun: true,
      ...this.opts,
    };

    this.opts.lockRenewTime =
      this.opts.lockRenewTime || this.opts.lockDuration / 2;

    this.blockingConnection = new RedisConnection(
      isRedisInstance(opts.connection)
        ? (<Redis>opts.connection).duplicate()
        : opts.connection,
    );
    this.blockingConnection.on('error', this.emit.bind(this, 'error'));

    if (processor) {
      if (typeof processor === 'function') {
        this.processFn = processor;
      } else {
        // SANDBOXED
        const supportedFileTypes = ['.js', '.ts', '.flow'];
        const processorFile =
          processor +
          (supportedFileTypes.includes(path.extname(processor)) ? '' : '.js');

        if (!fs.existsSync(processorFile)) {
          throw new Error(`File ${processorFile} does not exist`);
        }

        let masterFile = path.join(__dirname, './master.js');
        try {
          fs.statSync(masterFile); // would throw if file not exists
        } catch (_) {
          masterFile = path.join(process.cwd(), 'dist/classes/master.js');
          fs.statSync(masterFile);
        }

        this.childPool = new ChildPool(masterFile);
        this.processFn = sandbox<DataType, ResultType, NameType>(
          processor,
          this.childPool,
        ).bind(this);
      }
      this.timerManager = new TimerManager();

      if (this.opts.autorun) {
        this.run().catch(error => this.emit('error', error));
      }
    }

    this.on('error', err => console.error(err));
  }

  protected callProcessJob(
    job: Job<DataType, ResultType, NameType>,
    token: string,
  ): Promise<ResultType> {
    return this.processFn(job, token);
  }

  /**
   *
   * Waits until the worker is ready to start processing jobs.
   * In general only useful when writing tests.
   *
   */
  async waitUntilReady(): Promise<RedisClient> {
    await super.waitUntilReady();
    return this.blockingConnection.client;
  }

  get repeat(): Promise<Repeat> {
    return new Promise<Repeat>(async resolve => {
      if (!this._repeat) {
        const connection = await this.client;
        this._repeat = new Repeat(this.name, {
          ...this.opts,
          connection,
        });
        this._repeat.on('error', e => this.emit.bind(this, e));
      }
      resolve(this._repeat);
    });
  }

  async run() {
    if (this.processFn) {
      if (!this.running) {
        try {
          this.running = true;
          const client = await this.blockingConnection.client;

          if (this.closing) {
            return;
          }

          // IDEA, How to store metadata associated to a worker.
          // create a key from the worker ID associated to the given name.
          // We keep a hash table bull:myqueue:workers where
          // every worker is a hash key workername:workerId with json holding
          // metadata of the worker. The worker key gets expired every 30 seconds or so, we renew the worker metadata.
          //
          try {
            await client.client('setname', this.clientName());
          } catch (err) {
            if (!clientCommandMessageReg.test((<Error>err).message)) {
              throw err;
            }
          }

          const opts: WorkerOptions = <WorkerOptions>this.opts;

          const processing = (this.processing = new Map());

          const tokens: string[] = Array.from(
            { length: opts.concurrency },
            () => v4(),
          );

          while (!this.closing) {
            if (processing.size < opts.concurrency) {
              const token = tokens.pop();
              processing.set(
                this.retryIfFailed<Job<any, any, string>>(
                  () => this.getNextJob(token),
                  this.opts.runRetryDelay,
                ),
                token,
              );
            }

            /*
             * Get the first promise that completes
             */
            const promises = [...processing.keys()];
            const completedIdx = await Promise.race(
              promises.map((p, idx) => p.then(() => idx)),
            );

            const completed = promises[completedIdx];

            const token = processing.get(completed);
            processing.delete(completed);

            const job = await completed;
            if (job) {
              // reuse same token if next job is available to process
              processing.set(
                this.retryIfFailed<void | Job<any, any, string>>(
                  () => this.processJob(job, token),
                  this.opts.runRetryDelay,
                ),
                token,
              );
            } else {
              tokens.push(token);
            }
          }
          this.running = false;
          return Promise.all([...processing.keys()]);
        } catch (error) {
          this.running = false;

          throw error;
        }
      } else {
        throw new Error('Worker is already running.');
      }
    } else {
      throw new Error('No process function is defined.');
    }
  }

  /**
   * Returns a promise that resolves to the next job in queue.
   * @param token - worker token to be assigned to retrieved job
   * @returns a Job or undefined if no job was available in the queue.
   */
  async getNextJob(token: string, { block = true }: GetNextJobOptions = {}) {
    if (this.paused) {
      if (block) {
        await this.paused;
      } else {
        return;
      }
    }

    if (this.closing) {
      return;
    }

    if (this.drained && block) {
      try {
        const jobId = await this.waitForJob();
        return this.moveToActive(token, jobId);
      } catch (err) {
        // Swallow error if locally paused or closing since we did force a disconnection
        if (
          !(
            (this.paused || this.closing) &&
            (<Error>err).message === 'Connection is closed.'
          )
        ) {
          throw err;
        }
      }
    } else {
      return this.moveToActive(token);
    }
  }

  private async moveToActive(token: string, jobId?: string) {
    const [jobData, id] = await Scripts.moveToActive(this, token, jobId);
    return this.nextJobFromJobData(jobData, id);
  }

  private async waitForJob() {
    const client = await this.blockingConnection.client;

    if (this.paused) {
      return;
    }

    let jobId;
    const opts: WorkerOptions = <WorkerOptions>this.opts;

    try {
      this.waiting = true;
      jobId = await client.brpoplpush(
        this.keys.wait,
        this.keys.active,
        opts.drainDelay,
      );
    } catch (error) {
      if (isNotConnectionError(<Error>error)) {
        this.emit('error', error);
      }
      await this.delay();
    } finally {
      this.waiting = false;
    }
    return jobId;
  }

  /**
   *
   * This function is exposed only for testing purposes.
   */
  async delay(): Promise<void> {
    await delay(DELAY_TIME_1);
  }

  protected async nextJobFromJobData(
    jobData?: JobJsonRaw | number,
    jobId?: string,
  ): Promise<Job<any, any, string>> {
    if (jobData) {
      this.drained = false;

      //
      // Check if the queue is rate limited. jobData will be the amount
      // of rate limited jobs.
      //
      if (typeof jobData === 'number') {
        if (this.opts.limiter.workerDelay) {
          const rateKeyExpirationTime = jobData;
          await delay(rateKeyExpirationTime);
        }
      } else {
        const job = Job.fromJSON(this, jobData, jobId);
        if (job.opts.repeat) {
          const repeat = await this.repeat;
          await repeat.addNextRepeatableJob(job.name, job.data, job.opts);
        }
        return job;
      }
    } else if (!this.drained) {
      this.emit('drained');
      this.drained = true;
    }
  }

  async processJob(
    job: Job<DataType, ResultType, NameType>,
    token: string,
  ): Promise<void | Job<any, any, string>> {
    if (!job || this.closing || this.paused) {
      return;
    }

    // code from Bull3..

    //
    // There are two cases to take into consideration regarding locks.
    // 1) The lock renewer fails to renew a lock, this should make this job
    // unable to complete, since some other worker is also working on it.
    // 2) The lock renewer is called more seldom than the check for stalled
    // jobs, so we can assume the job has been stalled and is already being processed
    // by another worker. See https://github.com/OptimalBits/bull/issues/308
    //
    // TODO: Have only 1 timer that extends all the locks instead of one timer
    // per concurrency setting.
    let lockRenewId: string;
    let timerStopped = false;
    const lockExtender = () => {
      lockRenewId = this.timerManager.setTimer(
        'lockExtender',
        this.opts.lockRenewTime,
        async () => {
          try {
            const result = await job.extendLock(token, this.opts.lockDuration);
            if (result && !timerStopped) {
              lockExtender();
            }
            // FIXME if result = 0 (missing lock), reject processFn promise to take next job?
          } catch (error) {
            console.error('Error extending lock ', error);
            // Somehow tell the worker this job should stop processing...
          }
        },
      );
    };

    const stopTimer = () => {
      timerStopped = true;
      this.timerManager.clearTimer(lockRenewId);
    };

    // end copy-paste from Bull3

    const handleCompleted = async (result: ResultType) => {
      const jobData = await job.moveToCompleted(
        result,
        token,
        !(this.closing || this.paused),
      );
      this.emit('completed', job, result, 'active');
      return jobData ? this.nextJobFromJobData(jobData[0], jobData[1]) : null;
    };

    const handleFailed = async (err: Error) => {
      try {
        await job.moveToFailed(err, token);
        this.emit('failed', job, err, 'active');
      } catch (err) {
        this.emit('error', err);
        // It probably means that the job has lost the lock before completion
        // The QueueScheduler will (or already has) moved the job back
        // to the waiting list (as stalled)
      }
    };

    this.emit('active', job, 'waiting');

    lockExtender();
    try {
      const result = await this.callProcessJob(job, token);
      return await handleCompleted(result);
    } catch (err) {
      return handleFailed(<Error>err);
    } finally {
      stopTimer();
    }
  }

  /**
   *
   * Pauses the processing of this queue only for this worker.
   */
  async pause(doNotWaitActive?: boolean): Promise<void> {
    if (!this.paused) {
      this.paused = new Promise(resolve => {
        this.resumeWorker = function () {
          resolve();
          this.paused = null; // Allow pause to be checked externally for paused state.
          this.resumeWorker = null;
        };
      });
      await (!doNotWaitActive && this.whenCurrentJobsFinished());
      this.emit('paused');
    }
  }

  /**
   *
   * Resumes processing of this worker (if paused).
   */
  resume() {
    if (this.resumeWorker) {
      this.resumeWorker();
      this.emit('resumed');
    }
  }

  /**
   *
   * Checks if worker is paused.
   *
   * @returns true if worker is paused, false otherwise.
   */
  isPaused(): boolean {
    return !!this.paused;
  }

  /**
   *
   * Checks if worker is currently running.
   *
   * @returns true if worker is running, false otherwise.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   *
   * Closes the worker and related redis connections.
   *
   * This method waits for current jobs to finalize before returning.
   *
   * @param force - Use force boolean parameter if you do not want to wait for
   * current jobs to be processed.
   *
   * @returns Promise that resolves when the worker has been closed.
   */
  close(force = false) {
    if (this.closing) {
      return this.closing;
    }
    this.closing = (async () => {
      this.emit('closing', 'closing queue');

      const client = await this.blockingConnection.client;

      this.resume();
      await Promise.resolve()
        .finally(() => {
          return force || this.whenCurrentJobsFinished(false);
        })
        .finally(() => {
          const closePoolPromise = this.childPool?.clean();

          if (force) {
            // since we're not waiting for the job to end attach
            // an error handler to avoid crashing the whole process
            closePoolPromise?.catch(err => {
              console.error(err);
            });
            return;
          }
          return closePoolPromise;
        })
        .finally(() => client.disconnect())
        .finally(() => this.timerManager && this.timerManager.clearAllTimers())
        .finally(() => this.connection.close())
        .finally(() => this.emit('closed'));
    })();
    return this.closing;
  }

  /**
   * Returns a promise that resolves when active jobs are cleared
   *
   * @returns
   */
  private async whenCurrentJobsFinished(reconnect = true) {
    //
    // Force reconnection of blocking connection to abort blocking redis call immediately.
    //
    if (this.waiting) {
      await this.blockingConnection.disconnect();
    } else {
      reconnect = false;
    }

    if (this.processing) {
      await Promise.all(this.processing.keys());
    }

    reconnect && (await this.blockingConnection.reconnect());
  }

  private async retryIfFailed<T>(fn: () => Promise<T>, delayInMs: number) {
    const retry = 1;
    do {
      try {
        return await fn();
      } catch (err) {
        if (delayInMs) {
          await delay(delayInMs);
        } else {
          return;
        }
      }
    } while (retry);
  }
}
