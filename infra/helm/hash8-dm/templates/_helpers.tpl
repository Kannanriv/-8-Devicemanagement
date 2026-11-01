{{/* Chart name / fullname */}}
{{- define "hash8-dm.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hash8-dm.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "hash8-dm.labels" -}}
app.kubernetes.io/name: {{ include "hash8-dm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: hash8-dm
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Selector labels for a component: include "hash8-dm.selector" (dict "root" $ "component" "api") */}}
{{- define "hash8-dm.selector" -}}
app.kubernetes.io/name: {{ include "hash8-dm.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "hash8-dm.image" -}}
{{- $img := index .root.Values.image .which -}}
{{- printf "%s/%s:%s" .root.Values.global.imageRegistry $img.repository (default .root.Chart.AppVersion $img.tag) -}}
{{- end -}}

{{- define "hash8-dm.secretName" -}}
{{- default (printf "%s-secrets" (include "hash8-dm.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "hash8-dm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}{{ include "hash8-dm.fullname" . }}{{- else -}}default{{- end -}}
{{- end -}}

{{/* Shared env for the API image (api / ingest / decoder roles) */}}
{{- define "hash8-dm.apiEnv" -}}
- name: ROLE
  value: {{ .role | quote }}
- name: POD_NAME
  valueFrom: { fieldRef: { fieldPath: metadata.name } }
- name: OTEL_SERVICE_NAME
  value: {{ printf "hash8-%s" .role | quote }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: {{ printf "service.namespace=hash8-dm,deployment.environment=%s" .root.Release.Namespace | quote }}
{{- end -}}

{{- define "hash8-dm.apiEnvFrom" -}}
- configMapRef:
    name: {{ include "hash8-dm.fullname" . }}-config
- secretRef:
    name: {{ include "hash8-dm.secretName" . }}
{{- end -}}

{{/* Writable scratch dirs (root FS is read-only) */}}
{{- define "hash8-dm.tmpVolumes" -}}
- name: tmp
  emptyDir: {}
- name: data
  emptyDir: {}
{{- end -}}
{{- define "hash8-dm.tmpMounts" -}}
- name: tmp
  mountPath: /tmp
- name: data
  mountPath: /data
{{- end -}}

{{/* Pod-level checksum annotations so config changes roll pods */}}
{{- define "hash8-dm.podAnnotations" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
checksum/secret: {{ include (print .Template.BasePath "/secrets.yaml") . | sha256sum }}
{{- end -}}
