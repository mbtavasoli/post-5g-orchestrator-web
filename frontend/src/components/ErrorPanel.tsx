import { Alert, AlertTitle, List, ListItem, Typography } from "@mui/material";
import type { ReactNode } from "react";

import { ApiError } from "../api/client";
import { ERROR_KIND_LABELS } from "../api/errorKinds";
import type { ApiErrorBody } from "../api/types";


interface ErrorPanelProps {
  error?: Error | null;
  body?: ApiErrorBody | null;
  title?: string;
  action?: ReactNode;
}

export default function ErrorPanel({ error, body, title, action }: ErrorPanelProps) {
  const apiError = error instanceof ApiError ? error : null;
  const envelope = body ?? apiError?.body ?? null;
  const details = envelope?.details ?? [];
  const message = envelope?.message ?? error?.message ?? "Unknown error.";
  const heading = title ?? (envelope ? ERROR_KIND_LABELS[envelope.kind] ?? envelope.kind : "Error");
  const severity = envelope && ["authentication_required", "reservation_required", "conflict"].includes(envelope.kind)
    ? "warning"
    : "error";

  return (
    <Alert severity={severity} variant="outlined" role="alert" action={action} sx={{ alignItems: "flex-start" }}>
      <AlertTitle sx={{ fontWeight: 800 }}>{heading}</AlertTitle>
      <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>{message}</Typography>
      {envelope && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
          {envelope.kind} · {envelope.stage}
          {envelope.provider ? ` · ${envelope.provider}` : ""}
          {apiError ? ` · HTTP ${apiError.status}` : ""}
          {envelope.exception ? ` · ${envelope.exception}` : ""}
        </Typography>
      )}
      {details.length > 0 && (
        <List dense disablePadding sx={{ mt: 1 }}>
          {details.map((detail, index) => (
            <ListItem key={`${detail.loc?.join(".") ?? "error"}-${index}`} disableGutters sx={{ display: "list-item", ml: 2 }}>
              <Typography variant="body2" sx={{ overflowWrap: "anywhere", fontFamily: detail.loc?.[0] === "ansible" ? "monospace" : undefined, fontSize: detail.loc?.[0] === "ansible" ? 12 : undefined }}>
                {detail.loc?.join(" › ") ?? "Input"}: {detail.msg ?? detail.type ?? "Invalid value"}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}
    </Alert>
  );
}
