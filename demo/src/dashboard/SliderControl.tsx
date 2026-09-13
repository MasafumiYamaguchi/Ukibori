import { useId } from "react";

export interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  disabled?: boolean;
  hint?: string;
  onChange: (value: number) => void;
}

/** Accessible labeled range + output used by the Playground and Feature Lab. */
export function SliderControl({
  label,
  value,
  min,
  max,
  step,
  format = String,
  disabled = false,
  hint,
  onChange,
}: SliderControlProps) {
  const id = useId();
  return (
    <div className={`field${disabled ? " is-disabled" : ""}`}>
      <div className="field-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{format(value)}</output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint !== undefined ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
