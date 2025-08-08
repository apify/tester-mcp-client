import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import type { Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { log } from 'apify';

import { TELEMETRY_PROJECT_NAME } from './const.js';

/**
 * Create a OpenTelemetry provider and return a tracer instance.
 * @example
 * ```typescript
 * // Example usage of the tracer
 * tracer.startActiveSpan('test-span', (span) => {
 *     span.setAttribute('test-attribute', 'value');
 *
 *     // Simulate some work
 *     setTimeout(() => {
 *         span.setAttribute('test-duration', '100ms');
 *         span.end();
 *     }, 100);
 * });
 * ```
 */
export function initializeTelemetry(phoenixApiKey: string, collectorEndpoint: string, telemetryProjectName: string): Tracer {
    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: telemetryProjectName,
            [SEMRESATTRS_PROJECT_NAME]: telemetryProjectName,
        }),
        spanProcessors: [
            new SimpleSpanProcessor(
                new OTLPTraceExporter({
                    url: `${collectorEndpoint}/v1/traces`,
                    // (optional) if connecting to Phoenix with Authentication enabled
                    headers: { Authorization: `Bearer ${phoenixApiKey}` },
                }),
            ),
        ],
    });

    provider.register();

    process.on('exit', async () => {
        log.debug('Shutting down OpenTelemetry provider...');
        provider.shutdown().catch(log.error);
        log.debug('OpenTelemetry provider shutdown complete.');
    });

    return provider.getTracer(TELEMETRY_PROJECT_NAME);
}

/** Compatible tracer, no-op implementation */
export function noopTracer(): Tracer {
    return new BasicTracerProvider().getTracer(TELEMETRY_PROJECT_NAME);
}
