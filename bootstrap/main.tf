terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.71"
    }
  }
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_s3_bucket" "tf_bootstrap_clamux" {
  bucket        = "tf-bootstrap-clamux-145302888455"
  force_destroy = false
  tags = {
    Name        = "Clamux Bootstrap"
    Environment = "Prod"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tf_bootstrap_clamux_versioning" {
  bucket = aws_s3_bucket.tf_bootstrap_clamux.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_bootstrap_clamux_encryption" {
  bucket = aws_s3_bucket.tf_bootstrap_clamux.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_bootstrap_clamux_public_access_block" {
  bucket = aws_s3_bucket.tf_bootstrap_clamux.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}