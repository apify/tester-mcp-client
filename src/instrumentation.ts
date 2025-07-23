import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import type { Tracer } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const COLLECTOR_ENDPOINT = 'https://app.phoenix.arize.com/s/michal-kalita';
const SERVICE_NAME = 'mcp-client';

export function initializeTelemetry(): Tracer {
    const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: SERVICE_NAME,
            [SEMRESATTRS_PROJECT_NAME]: SERVICE_NAME,
        }),
        spanProcessors: [
            new SimpleSpanProcessor(
                new OTLPTraceExporter({
                    url: `${COLLECTOR_ENDPOINT}/v1/traces`,
                    // (optional) if connecting to Phoenix with Authentication enabled
                    headers: { Authorization: `Bearer ${process.env.PHOENIX_API_KEY}` },
                }),
            ),
        ],
    });

    provider.register();

    // Example usage of the tracer
    // tracer.startActiveSpan('test-span', (span) => {
    //     span.setAttribute('test-attribute', 'value');

    //     // Simulate some work
    //     setTimeout(() => {
    //         span.setAttribute('test-duration', '100ms');
    //         span.end();
    //     }, 100);
    // });

    process.on('exit', async () => {
        console.log('Shutting down OpenTelemetry provider...');
        provider.shutdown().catch(console.error);
        console.log('OpenTelemetry provider shutdown complete.');
    });

    return provider.getTracer(SERVICE_NAME);
}

/** Compatible tracer, no-op implementation */
export function noopTracer(): Tracer {
    return new BasicTracerProvider().getTracer(SERVICE_NAME);
}
