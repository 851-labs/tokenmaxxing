import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

const FIELD =
  "w-full border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground";

function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(FIELD, className)} {...rest} />;
}

function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(FIELD, className)} {...rest} />;
}

export { Input, Textarea };
