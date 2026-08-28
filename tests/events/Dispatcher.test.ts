import { describe, expect, test } from 'vitest';
import { Dispatcher } from '../../src/events/Dispatcher';

describe('Dispatcher', (): void => {
    test('delivers an event to a listener', (): void => {
        const seen: string[] = [];
        function listener(event: Event): void {
            seen.push(event.type);
        }

        Dispatcher.listen('db:test-delivered', listener);
        Dispatcher.dispatch(new Event('db:test-delivered'));
        Dispatcher.forget('db:test-delivered', listener);

        expect(seen).toEqual(['db:test-delivered']);
    });

    test('keeps a listener registered across events', (): void => {
        let count: number = 0;
        function listener(): void {
            count++;
        }

        Dispatcher.listen('db:test-persistent', listener);
        Dispatcher.dispatch(new Event('db:test-persistent'));
        Dispatcher.dispatch(new Event('db:test-persistent'));
        Dispatcher.forget('db:test-persistent', listener);

        expect(count).toEqual(2);
    });

    test('drops a once listener after the first event', (): void => {
        let count: number = 0;

        Dispatcher.listen('db:test-once', (): void => {
            count++;
        }, true);

        Dispatcher.dispatch(new Event('db:test-once'));
        Dispatcher.dispatch(new Event('db:test-once'));

        expect(count).toEqual(1);
    });

    test('stops delivering to a forgotten listener', (): void => {
        let count: number = 0;
        function listener(): void {
            count++;
        }

        Dispatcher.listen('db:test-forgotten', listener);
        Dispatcher.forget('db:test-forgotten', listener);
        Dispatcher.dispatch(new Event('db:test-forgotten'));

        expect(count).toEqual(0);
    });

    test('ignores an event nobody listens for', (): void => {
        expect((): void => Dispatcher.dispatch(new Event('db:test-unheard'))).not.toThrow();
    });
});
