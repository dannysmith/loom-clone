import { useRef, useState } from 'react';
import { Editor } from './Editor';
import { Preview } from './preview/Preview';
import { buildInitialState, type CoverState, type VideoInputs } from './state';

type Props = {
  inputs: VideoInputs;
};

export function App({ inputs }: Props) {
  const [state, setState] = useState<CoverState>(() => buildInitialState(inputs));
  const svgRef = useRef<SVGSVGElement>(null);

  return (
    <div className="cover-page">
      <header className="cover-topbar">
        <a className="cover-back-link" href={`/admin/videos/${inputs.videoId}`}>
          &larr; Back
        </a>
        <span className="cover-page-title">
          {inputs.title.trim() || inputs.slug}
        </span>
      </header>
      <div className="app">
        <div className="preview-wrap">
          <div className="preview-frame">
            <Preview state={state} setState={setState} svgRef={svgRef} />
          </div>
        </div>
        <Editor inputs={inputs} state={state} setState={setState} svgRef={svgRef} />
      </div>
    </div>
  );
}
