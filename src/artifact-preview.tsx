import type { ResolvedOutput } from '@astra-spec/sdk';
import { ArtifactPreview } from '@astra-spec/ui/components';
import type { ArtifactPreviewData } from '@astra-spec/ui/lib';
import React, { useEffect, useState } from 'react';
import { JupyterArtifactAccess } from './artifact-access';

export function JupyterArtifactPreview({
  access,
  compact,
  output
}: {
  access: JupyterArtifactAccess;
  compact: boolean;
  output: ResolvedOutput;
}): React.ReactElement {
  const [preview, setPreview] = useState<ArtifactPreviewData | undefined>(
    output.artifact ? { kind: 'loading' } : undefined
  );

  useEffect(() => {
    const controller = new AbortController();
    setPreview(output.artifact ? { kind: 'loading' } : undefined);
    void access
      .getPreview(output, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          setPreview({
            kind: 'unavailable',
            reason:
              error instanceof Error
                ? error.message
                : 'The artifact preview could not be loaded.'
          });
        }
      });
    return () => controller.abort();
  }, [access, output]);

  return (
    <ArtifactPreview
      output={output}
      preview={preview}
      compact={compact}
      caption={null}
    />
  );
}
