// ─────────────────────────────────────────────────────────────────────────────
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Regenerate after every change to supabase/schema.sql:
//   npm run db:types
//
// A stale version of this file is a bug, not a nuisance: it is the only thing
// that makes a wrong column name or status value a compile error instead of a
// silent runtime `undefined`.
// ─────────────────────────────────────────────────────────────────────────────

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      attachments: {
        Row: {
          created_at: string
          filename: string
          id: string
          mime_type: string
          size_bytes: number
          storage_path: string
          user_id: string
        }
        Insert: {
          created_at?: string
          filename: string
          id?: string
          mime_type: string
          size_bytes: number
          storage_path: string
          user_id?: string
        }
        Update: {
          created_at?: string
          filename?: string
          id?: string
          mime_type?: string
          size_bytes?: number
          storage_path?: string
          user_id?: string
        }
        Relationships: []
      }
      events: {
        Row: {
          created_at: string
          id: number
          ip: unknown
          send_id: string
          type: Database["public"]["Enums"]["event_type"]
          url: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: number
          ip?: unknown
          send_id: string
          type: Database["public"]["Enums"]["event_type"]
          url?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: number
          ip?: unknown
          send_id?: string
          type?: Database["public"]["Enums"]["event_type"]
          url?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_send_id_fkey"
            columns: ["send_id"]
            isOneToOne: false
            referencedRelation: "sends"
            referencedColumns: ["id"]
          },
        ]
      }
      gmail_accounts: {
        Row: {
          access_token_enc: string | null
          access_token_expires_at: string | null
          created_at: string
          daily_limit: number
          display_name: string | null
          email: string
          follow_up_share_pct: number
          google_sub: string
          id: string
          refresh_token_enc: string
          scopes: string[]
          status: Database["public"]["Enums"]["account_status"]
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_enc?: string | null
          access_token_expires_at?: string | null
          created_at?: string
          daily_limit?: number
          display_name?: string | null
          email: string
          follow_up_share_pct?: number
          google_sub: string
          id?: string
          refresh_token_enc: string
          scopes?: string[]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
          user_id?: string
        }
        Update: {
          access_token_enc?: string | null
          access_token_expires_at?: string | null
          created_at?: string
          daily_limit?: number
          display_name?: string | null
          email?: string
          follow_up_share_pct?: number
          google_sub?: string
          id?: string
          refresh_token_enc?: string
          scopes?: string[]
          status?: Database["public"]["Enums"]["account_status"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      leads: {
        Row: {
          company_name: string
          created_at: string
          email: string
          first_name: string
          id: string
          job_title: string | null
          last_name: string
          personalization_line: string
          replied_at: string | null
          send_time_ist: string
          status: Database["public"]["Enums"]["lead_status"]
          updated_at: string
          user_id: string
          verification: Database["public"]["Enums"]["verification_status"]
          website: string | null
        }
        Insert: {
          company_name?: string
          created_at?: string
          email: string
          first_name?: string
          id?: string
          job_title?: string | null
          last_name?: string
          personalization_line?: string
          replied_at?: string | null
          send_time_ist?: string
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
          user_id?: string
          verification?: Database["public"]["Enums"]["verification_status"]
          website?: string | null
        }
        Update: {
          company_name?: string
          created_at?: string
          email?: string
          first_name?: string
          id?: string
          job_title?: string | null
          last_name?: string
          personalization_line?: string
          replied_at?: string | null
          send_time_ist?: string
          status?: Database["public"]["Enums"]["lead_status"]
          updated_at?: string
          user_id?: string
          verification?: Database["public"]["Enums"]["verification_status"]
          website?: string | null
        }
        Relationships: []
      }
      oauth_states: {
        Row: {
          created_at: string
          expires_at: string
          state: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          state: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          state?: string
        }
        Relationships: []
      }
      sends: {
        Row: {
          attempt_count: number
          body_html_rendered: string | null
          claimed_at: string | null
          created_at: string
          gmail_account_id: string
          gmail_message_id: string | null
          gmail_thread_id: string | null
          id: string
          is_follow_up: boolean
          last_error: string | null
          lead_id: string
          rfc822_message_id: string | null
          scheduled_at: string
          sent_at: string | null
          status: Database["public"]["Enums"]["send_status"]
          step_id: string | null
          step_position: number
          subject_rendered: string | null
          tracking_id: string
          user_id: string
        }
        Insert: {
          attempt_count?: number
          body_html_rendered?: string | null
          claimed_at?: string | null
          created_at?: string
          gmail_account_id: string
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          is_follow_up?: boolean
          last_error?: string | null
          lead_id: string
          rfc822_message_id?: string | null
          scheduled_at: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["send_status"]
          step_id?: string | null
          step_position: number
          subject_rendered?: string | null
          tracking_id?: string
          user_id?: string
        }
        Update: {
          attempt_count?: number
          body_html_rendered?: string | null
          claimed_at?: string | null
          created_at?: string
          gmail_account_id?: string
          gmail_message_id?: string | null
          gmail_thread_id?: string | null
          id?: string
          is_follow_up?: boolean
          last_error?: string | null
          lead_id?: string
          rfc822_message_id?: string | null
          scheduled_at?: string
          sent_at?: string | null
          status?: Database["public"]["Enums"]["send_status"]
          step_id?: string | null
          step_position?: number
          subject_rendered?: string | null
          tracking_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "sends_gmail_account_id_fkey"
            columns: ["gmail_account_id"]
            isOneToOne: false
            referencedRelation: "gmail_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sends_gmail_account_id_fkey"
            columns: ["gmail_account_id"]
            isOneToOne: false
            referencedRelation: "gmail_accounts_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sends_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sends_step_id_fkey"
            columns: ["step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      sequence_steps: {
        Row: {
          body_html: string | null
          id: string
          kind: Database["public"]["Enums"]["step_kind"]
          lead_id: string
          name: string
          position: number
          subject: string | null
          wait_days: number | null
        }
        Insert: {
          body_html?: string | null
          id?: string
          kind: Database["public"]["Enums"]["step_kind"]
          lead_id: string
          name?: string
          position: number
          subject?: string | null
          wait_days?: number | null
        }
        Update: {
          body_html?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["step_kind"]
          lead_id?: string
          name?: string
          position?: number
          subject?: string | null
          wait_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sequence_steps_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      settings: {
        Row: {
          follow_up_days: number[]
          jitter_max_seconds: number
          jitter_min_seconds: number
          outreach_days: number[]
          stale_send_grace_hours: number
          track_clicks: boolean
          track_opens: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          follow_up_days?: number[]
          jitter_max_seconds?: number
          jitter_min_seconds?: number
          outreach_days?: number[]
          stale_send_grace_hours?: number
          track_clicks?: boolean
          track_opens?: boolean
          updated_at?: string
          user_id?: string
        }
        Update: {
          follow_up_days?: number[]
          jitter_max_seconds?: number
          jitter_min_seconds?: number
          outreach_days?: number[]
          stale_send_grace_hours?: number
          track_clicks?: boolean
          track_opens?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      step_attachments: {
        Row: {
          attachment_id: string
          step_id: string
        }
        Insert: {
          attachment_id: string
          step_id: string
        }
        Update: {
          attachment_id?: string
          step_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "step_attachments_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "step_attachments_step_id_fkey"
            columns: ["step_id"]
            isOneToOne: false
            referencedRelation: "sequence_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      template_step_attachments: {
        Row: {
          attachment_id: string
          template_step_id: string
        }
        Insert: {
          attachment_id: string
          template_step_id: string
        }
        Update: {
          attachment_id?: string
          template_step_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "template_step_attachments_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "template_step_attachments_template_step_id_fkey"
            columns: ["template_step_id"]
            isOneToOne: false
            referencedRelation: "template_steps"
            referencedColumns: ["id"]
          },
        ]
      }
      template_steps: {
        Row: {
          body_html: string | null
          id: string
          kind: Database["public"]["Enums"]["step_kind"]
          name: string
          position: number
          subject: string | null
          template_id: string
          wait_days: number | null
        }
        Insert: {
          body_html?: string | null
          id?: string
          kind: Database["public"]["Enums"]["step_kind"]
          name?: string
          position: number
          subject?: string | null
          template_id: string
          wait_days?: number | null
        }
        Update: {
          body_html?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["step_kind"]
          name?: string
          position?: number
          subject?: string | null
          template_id?: string
          wait_days?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "template_steps_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "templates"
            referencedColumns: ["id"]
          },
        ]
      }
      templates: {
        Row: {
          created_at: string
          id: string
          name: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      gmail_accounts_public: {
        Row: {
          created_at: string | null
          daily_limit: number | null
          display_name: string | null
          email: string | null
          follow_up_share_pct: number | null
          id: string | null
          status: Database["public"]["Enums"]["account_status"] | null
        }
        Insert: {
          created_at?: string | null
          daily_limit?: number | null
          display_name?: string | null
          email?: string | null
          follow_up_share_pct?: number | null
          id?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
        }
        Update: {
          created_at?: string | null
          daily_limit?: number | null
          display_name?: string | null
          email?: string | null
          follow_up_share_pct?: number | null
          id?: string | null
          status?: Database["public"]["Enums"]["account_status"] | null
        }
        Relationships: []
      }
      lead_engagement: {
        Row: {
          click_count: number | null
          distinct_links: number | null
          last_click_at: string | null
          last_open_at: string | null
          lead_id: string | null
          open_count: number | null
          proxy_opens: number | null
          reply_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "sends_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      claim_due_sends: {
        Args: {
          p_account_id: string
          p_is_follow_up?: boolean
          p_limit: number
        }
        Returns: {
          attempt_count: number
          body_html_rendered: string | null
          claimed_at: string | null
          created_at: string
          gmail_account_id: string
          gmail_message_id: string | null
          gmail_thread_id: string | null
          id: string
          is_follow_up: boolean
          last_error: string | null
          lead_id: string
          rfc822_message_id: string | null
          scheduled_at: string
          sent_at: string | null
          status: Database["public"]["Enums"]["send_status"]
          step_id: string | null
          step_position: number
          subject_rendered: string | null
          tracking_id: string
          user_id: string
        }[]
        SetofOptions: {
          from: "*"
          to: "sends"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      sent_today_count: {
        Args: { p_account_id: string; p_is_follow_up?: boolean }
        Returns: number
      }
      set_send_budget: {
        Args: {
          p_account_id: string
          p_follow_up_share: number
          p_limit: number
        }
        Returns: undefined
      }
    }
    Enums: {
      account_status: "active" | "needs_reauth" | "revoked"
      event_type: "open" | "click" | "reply" | "bounce"
      lead_status:
        | "draft"
        | "scheduled"
        | "sending"
        | "sent"
        | "replied"
        | "failed"
        | "cancelled"
      send_status:
        | "pending"
        | "sending"
        | "sent"
        | "failed"
        | "skipped"
        | "cancelled"
      step_kind: "email" | "delay"
      verification_status: "verified" | "not_verified" | "invalid"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_status: ["active", "needs_reauth", "revoked"],
      event_type: ["open", "click", "reply", "bounce"],
      lead_status: [
        "draft",
        "scheduled",
        "sending",
        "sent",
        "replied",
        "failed",
        "cancelled",
      ],
      send_status: [
        "pending",
        "sending",
        "sent",
        "failed",
        "skipped",
        "cancelled",
      ],
      step_kind: ["email", "delay"],
      verification_status: ["verified", "not_verified", "invalid"],
    },
  },
} as const
