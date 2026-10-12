import { config } from "./config.js";

export interface RetrySchedule { topic: string; delaySeconds: number }

export function retrySchedules(): RetrySchedule[] {
  const cfg = config();
  return [
    { topic: cfg.KAFKA_RETRY_TOPIC_1M, delaySeconds: 60 },
    { topic: cfg.KAFKA_RETRY_TOPIC_5M, delaySeconds: 5 * 60 },
    { topic: cfg.KAFKA_RETRY_TOPIC_30M, delaySeconds: 30 * 60 },
    { topic: cfg.KAFKA_RETRY_TOPIC_2H, delaySeconds: 2 * 60 * 60 },
    { topic: cfg.KAFKA_RETRY_TOPIC_6H, delaySeconds: 6 * 60 * 60 },
    { topic: cfg.KAFKA_RETRY_TOPIC_24H, delaySeconds: 24 * 60 * 60 }
  ];
}

export function retryScheduleForAttempt(attempt: number): RetrySchedule {
  const schedules = retrySchedules();
  return schedules[Math.min(Math.max(attempt - 1, 0), schedules.length - 1)]!;
}

export function commandTopics(): string[] {
  return [config().KAFKA_COMMAND_TOPIC, ...retrySchedules().map(({ topic }) => topic)];
}
