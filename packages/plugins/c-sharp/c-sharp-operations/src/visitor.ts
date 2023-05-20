import autoBind from 'auto-bind';
import { pascalCase } from 'change-case-all';
import {
  DocumentNode,
  EnumTypeDefinitionNode,
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  GraphQLSchema,
  InputObjectTypeDefinitionNode,
  isEnumType,
  isInputObjectType,
  isScalarType,
  Kind,
  ObjectTypeDefinitionNode,
  OperationDefinitionNode,
  print,
  TypeNode,
  VariableDefinitionNode,
} from 'graphql';
import {
  Access,
  C_SHARP_SCALARS,
  convertSafeName,
  CSharpDeclarationBlock,
  CSharpFieldType,
  getListInnerTypeNode,
  getListTypeDepth,
  getListTypeField,
  isValueType,
  wrapFieldType,
} from '@graphql-codegen/c-sharp-common';
import { getCachedDocumentNodeFromSchema, Types } from '@graphql-codegen/plugin-helpers';
import {
  buildScalarsFromConfig,
  ClientSideBasePluginConfig,
  ClientSideBaseVisitor,
  DocumentMode,
  getBaseTypeNode,
  indentMultiline,
  LoadedFragment,
} from '@graphql-codegen/visitor-plugin-common';
import { CSharpOperationsRawPluginConfig } from './config.js';

const defaultSuffix = 'GQL';

export interface CSharpOperationsPluginConfig extends ClientSideBasePluginConfig {
  namespaceName: string;
  operationsClassName: string;
  namedClient: string;
  querySuffix: string;
  mutationSuffix: string;
  subscriptionSuffix: string;
  typesafeOperation: boolean;
  httpClientConfig?: {
    prodEndpoint: string;
    devEndpoint: string;
    useDevIf: string;
  };
}

export class CSharpOperationsVisitor extends ClientSideBaseVisitor<
  CSharpOperationsRawPluginConfig,
  CSharpOperationsPluginConfig
> {
  private _schemaAST: DocumentNode;

  constructor(
    schema: GraphQLSchema,
    fragments: LoadedFragment[],
    rawConfig: CSharpOperationsRawPluginConfig,
    documents?: Types.DocumentFile[],
  ) {
    super(
      schema,
      fragments,
      rawConfig,
      {
        namespaceName: rawConfig.namespaceName || 'GraphQLCodeGen',
        operationsClassName: rawConfig.operationsClassName || 'GraphQLClient',
        namedClient: rawConfig.namedClient,
        querySuffix: rawConfig.querySuffix || defaultSuffix,
        mutationSuffix: rawConfig.mutationSuffix || defaultSuffix,
        subscriptionSuffix: rawConfig.subscriptionSuffix || defaultSuffix,
        scalars: buildScalarsFromConfig(schema, rawConfig, C_SHARP_SCALARS),
        typesafeOperation: rawConfig.typesafeOperation || false,
        httpClientConfig: rawConfig.httpClientConfig ?? undefined,
      },
      documents,
    );

    if (this.config.documentMode === DocumentMode.graphQLTag) {
      // C# operations does not (yet) support graphQLTag mode
      this.config.documentMode = DocumentMode.documentNode;
    }

    autoBind(this);

    this._schemaAST = getCachedDocumentNodeFromSchema(schema);
  }

  public wrapWithNamespace(content: string, name: string): string {
    return new CSharpDeclarationBlock()
      .asKind('namespace')
      .withName(name)
      .withBlock(indentMultiline(content)).string;
  }

  public wrapWithClass(content: string, name: string, access: Access = 'public'): string {
    return new CSharpDeclarationBlock()
      .access(access)
      .asKind('class')
      .withName(convertSafeName(name))
      .withBlock(indentMultiline(content)).string;
  }

  protected _gql(node: OperationDefinitionNode): string {
    const fragments = this._transformFragments(node);
    const doc = this._prepareDocument(
      [print(node), this._includeFragments(fragments, node.kind)].join('\n'),
    );

    return doc.replace(/"/g, '""');
  }

  private _getDocumentNodeVariable(node: OperationDefinitionNode): string {
    if (this.config.documentMode !== DocumentMode.external) {
      const gqlBlock = indentMultiline(this._gql(node), 4);
      return `@"\n${gqlBlock}"`;
    } else {
      return `Operations.${node.name.value}`;
    }
  }

  private _gqlInputSignature(variable: VariableDefinitionNode): {
    signature: string;
    required: boolean;
  } {
    const typeNode = variable.type;
    const innerType = getBaseTypeNode(typeNode);
    const schemaType = this._schema.getType(innerType.name.value);

    const name = variable.variable.name.value;
    const baseType = !isScalarType(schemaType)
      ? innerType.name.value
      : this.scalars[schemaType.name] || 'object';

    const listType = getListTypeField(typeNode);
    const required = getListInnerTypeNode(typeNode).kind === Kind.NON_NULL_TYPE;

    return {
      required: listType ? listType.required : required,
      signature: !listType
        ? `${name}=(${baseType})`
        : `${name}=(${baseType}${'[]'.repeat(getListTypeDepth(listType))})`,
    };
  }

  public getCSharpImports(): string {
    let imports = [
      'System',
      'System.Collections.Generic',
      'System.Threading.Tasks',
      'System.Net.Http',
      'System.Net.Http.Headers',
      'Newtonsoft.Json',
      'GraphQL',
      'GraphQL.Client.Abstractions',
    ];

    if (this.config.httpClientConfig) {
      imports = imports.concat(['GraphQL.Client.Serializer.Newtonsoft', 'GraphQL.Client.Http']);
    }

    return imports.map(i => `using ${i};`).join('\n') + '\n';
  }

  public getClientDeclaration(): string {
    if (!this.config.httpClientConfig) return '';

    const { prodEndpoint, devEndpoint, useDevIf } = this.config.httpClientConfig;
    if (!prodEndpoint) return '';

    // let clientDeclaration = `public partial class ${this.config.operationsClassName} {\n`;

    let clientDeclaration = `private static GraphQLHttpClient _client;\n`;

    if (!useDevIf || !devEndpoint) {
      clientDeclaration += `private static GraphQLHttpClient client {
          get {
            if (_client == null) {
              _client = new GraphQLHttpClient("${prodEndpoint}", new NewtonsoftJsonSerializer());
            }

            return _client;
          }
        }`;
    } else {
      clientDeclaration += `private static GraphQLHttpClient client {
          get {
            if (_client == null) {
              var endpoint = ${useDevIf} ? "${devEndpoint}" : "${prodEndpoint}";
              _client = new GraphQLHttpClient(endpoint, new NewtonsoftJsonSerializer());
            }

            return _client;
          }
        }`;
    }

    // clientDeclaration += `\n}`;

    return clientDeclaration;
  }

  public getHttpRequestClass() {
    if (!this.config.httpClientConfig) return '';

    return `
    internal class GraphQLHttpRequestWithHeaders : GraphQLHttpRequest {
      public string AuthToken { get; set; }
      public Dictionary<string, string> Headers { get; set; }

      public override HttpRequestMessage ToHttpRequestMessage(
          GraphQLHttpClientOptions options,
          IGraphQLJsonSerializer serializer) {
          var r = base.ToHttpRequestMessage(options, serializer);

          if (AuthToken != null) {
              r.Headers.Authorization = new AuthenticationHeaderValue("Bearer", AuthToken);
          }

          if (Headers != null) {
              foreach (var h in Headers) {
                  r.Headers.Add(h.Key, h.Value);
              }
          }

          return r;
      }
    }`;
  }

  public getHasErrorExtension() {
    return `
    public static class GraphQLResponseExtensions {
        public static bool HasError<T>(this GraphQLResponse<T> response) {
            return response.Errors != null;
        }
    }`;
  }

  protected resolveFieldType(
    typeNode: TypeNode,
    hasDefaultValue: Boolean = false,
  ): CSharpFieldType {
    const innerType = getBaseTypeNode(typeNode);
    const schemaType = this._schema.getType(innerType.name.value);
    const listType = getListTypeField(typeNode);
    const required = getListInnerTypeNode(typeNode).kind === Kind.NON_NULL_TYPE;

    let result: CSharpFieldType = null;

    if (isScalarType(schemaType)) {
      if (this.scalars[schemaType.name]) {
        const baseType = this.scalars[schemaType.name];
        result = new CSharpFieldType({
          baseType: {
            type: baseType,
            required,
            valueType: isValueType(baseType),
          },
          listType,
        });
      } else {
        result = new CSharpFieldType({
          baseType: {
            type: 'object',
            required,
            valueType: false,
          },
          listType,
        });
      }
    } else if (isInputObjectType(schemaType)) {
      result = new CSharpFieldType({
        baseType: {
          type: `${this.convertName(schemaType.name)}`,
          required,
          valueType: false,
        },
        listType,
      });
    } else if (isEnumType(schemaType)) {
      result = new CSharpFieldType({
        baseType: {
          type: this.convertName(schemaType.name),
          required,
          valueType: true,
        },
        listType,
      });
    } else {
      result = new CSharpFieldType({
        baseType: {
          type: `${schemaType.name}`,
          required,
          valueType: false,
        },
        listType,
      });
    }

    if (hasDefaultValue) {
      // Required field is optional when default value specified, see #4273
      (result.listType || result.baseType).required = false;
    }

    return result;
  }

  private _getFieldDefinition(node: FieldNode, parentSchema: ObjectTypeDefinitionNode): string {
    const fieldSchema = parentSchema.fields.find(f => f.name.value === node.name.value);
    if (!fieldSchema) {
      throw new Error(`Field schema not found; ${node.name.value}`);
    }
    const responseType = this.resolveFieldType(fieldSchema.type);

    if (!node.selectionSet) {
      const responseTypeName = wrapFieldType(responseType, responseType.listType, 'List');
      return indentMultiline(
        [
          `[JsonProperty("${node.name.value}")]`,
          `public ${responseTypeName} ${convertSafeName(
            pascalCase(node.name.value),
          )} { get; set; }`,
        ].join('\n') + '\n',
      );
    }
    // const selectionBaseTypeName = this._getResponseDataClassName();

    const innerClassSchema = this._schemaAST.definitions.find(
      d => d.kind === Kind.OBJECT_TYPE_DEFINITION && d.name.value === responseType.baseType.type,
    ) as ObjectTypeDefinitionNode;

    if (
      node.selectionSet.selections.length === 1 &&
      node.selectionSet.selections[0].kind === Kind.FRAGMENT_SPREAD
    ) {
      const fragmentNode = node.selectionSet.selections[0];
      let responseTypeName = this._getFragmentClassName(fragmentNode);
      let responseVariableName: string;
      if (responseType.listType) {
        responseVariableName = responseTypeName + 's';
        responseTypeName = `List<${responseTypeName}>`;
      } else {
        responseVariableName = responseTypeName;
      }
      return indentMultiline(
        [
          `[JsonProperty("${node.name.value}")]`,
          `public ${responseTypeName} ${responseVariableName} { get; set; }`,
        ].join('\n') + '\n',
      );
    } else {
      const selectionFields = node.selectionSet.selections
        .map(s => {
          if (s.kind === Kind.INLINE_FRAGMENT) {
            throw new Error(`Unsupported kind; ${node.name} ${s.kind}`);
          } else if (s.kind === Kind.FRAGMENT_SPREAD) {
            return this._getFragmentSpreadDefinition(s, innerClassSchema);
          } else {
            return this._getFieldDefinition(s, innerClassSchema);
          }
        })
        .join('\n');

      const fieldType = new CSharpFieldType(responseType);

      let baseTypeName = pascalCase(node.name.value);
      if (fieldType.listType && baseTypeName.endsWith('s')) {
        baseTypeName = baseTypeName.slice(0, -1);
      }

      baseTypeName += 'Result';
      baseTypeName = convertSafeName(baseTypeName);

      const selectionType = Object.assign(fieldType, {
        baseType: { type: baseTypeName },
      });

      const selectionTypeName = wrapFieldType(selectionType, selectionType.listType, 'List');

      const innerClassDefinition = new CSharpDeclarationBlock()
        .access('public')
        .asKind('class')
        .withName(baseTypeName)
        .withBlock(selectionFields).string;

      return indentMultiline(
        [
          innerClassDefinition,
          `[JsonProperty("${node.name.value}")]`,
          `public ${selectionTypeName} Result { get; set; }`,
        ].join('\n') + '\n',
      );
    }
  }

  private _getFragmentSpreadDefinition(
    node: FragmentSpreadNode,
    parentSchema: ObjectTypeDefinitionNode,
  ): string {
    const fragmentSchema = this._fragments.find(f => f.name === node.name.value);
    if (!fragmentSchema) {
      throw new Error(`Fragment schema not found; ${node.name.value}`);
    }
    return fragmentSchema.node.selectionSet.selections
      .map(s => {
        if (s.kind === Kind.INLINE_FRAGMENT) {
          throw new Error(`Unsupported kind; ${node.name} ${s.kind}`);
        } else if (s.kind === Kind.FIELD) {
          return this._getFieldDefinition(s, parentSchema);
        } else {
          return this._getFragmentSpreadDefinition(s, parentSchema);
        }
      })
      .join('\n');
  }

  private _getResponseClassName(node: OperationDefinitionNode): string {
    let className = `${this.convertName(node)}Payload`;

    if (className.startsWith('Get')) {
      className = className.slice(3);
    }

    return className;
  }

  private _getVariablesClassName(node: OperationDefinitionNode): string {
    return `${this.convertName(node)}Request`;
  }

  public getResponseClass(node: OperationDefinitionNode): string {
    const operationSchema = this._schemaAST.definitions.find(
      s => s.kind === Kind.OBJECT_TYPE_DEFINITION && s.name.value.toLowerCase() === node.operation,
    );

    return new CSharpDeclarationBlock()
      .access('public')
      .asKind('class')
      .withName(this._getResponseClassName(node))
      .withBlock(
        '\n' +
          node.selectionSet.selections
            .map(opr => {
              if (opr.kind !== Kind.FIELD) {
                throw new Error(`Unknown kind; ${opr.kind} in OperationDefinitionNode`);
              }

              return this._getFieldDefinition(opr, operationSchema as ObjectTypeDefinitionNode);
            })
            .join('\n'),
      ).string;
  }

  private _getFragmentClassName(node: FragmentSpreadNode): string {
    return this.convertName(node);
  }

  public getFragmentClass(node: FragmentDefinitionNode): string {
    const fragmentSchema = this._schemaAST.definitions.find(
      s => s.kind === Kind.OBJECT_TYPE_DEFINITION && s.name.value === node.typeCondition.name.value,
    );

    return new CSharpDeclarationBlock()
      .access('public')
      .asKind('class')
      .withName(this.convertName(node))
      .withBlock(
        '\n' +
          node.selectionSet.selections
            .map(opr => {
              if (opr.kind !== Kind.FIELD) {
                throw new Error(`Unknown kind; ${opr.kind} in OperationDefinitionNode`);
              }
              return this._getFieldDefinition(opr, fragmentSchema as ObjectTypeDefinitionNode);
            })
            .join('\n'),
      ).string;
  }

  public getRequestClass(node: OperationDefinitionNode): string {
    if (!node.variableDefinitions?.length) {
      return '';
    }

    const fields =
      '\n' +
      node.variableDefinitions
        ?.map(v => {
          const inputType = this.resolveFieldType(v.type);
          const inputTypeName = wrapFieldType(inputType, inputType.listType, 'List');
          const inputVariableName = convertSafeName(pascalCase(v.variable.name.value));

          return indentMultiline(
            [
              `[JsonProperty("${v.variable.name.value}")]`,
              `public ${inputTypeName} ${inputVariableName} { get; set; }`,
            ].join('\n') + '\n',
          );
        })
        .join('\n');

    let constructorParams = '';

    for (let i = 0; i < node.variableDefinitions.length; i++) {
      const variable = node.variableDefinitions[i];
      const inputType = this.resolveFieldType(variable.type);
      const inputTypeName = wrapFieldType(inputType, inputType.listType, 'List');
      const inputName = convertSafeName(variable.variable.name.value);

      constructorParams += `${inputTypeName} ${inputName}`;

      if (i < node.variableDefinitions.length - 1) {
        constructorParams += ', ';
      }
    }

    let constructor = `public ${this._getVariablesClassName(node)}(${constructorParams}) {`;

    for (let i = 0; i < node.variableDefinitions.length; i++) {
      const variable = node.variableDefinitions[i];
      const inputName = convertSafeName(variable.variable.name.value);
      const inputVariableName = convertSafeName(pascalCase(variable.variable.name.value));

      constructor += `\n  ${inputVariableName} = ${inputName};`;
    }

    constructor += '\n}';

    const contents = [fields, constructor].join('\n');

    return new CSharpDeclarationBlock()
      .access('public')
      .asKind('class')
      .withName(this._getVariablesClassName(node))
      .withBlock(contents).string;
  }

  public getEnumDefinition(node: EnumTypeDefinitionNode): string {
    const enumDefinition = new CSharpDeclarationBlock()
      .access('public')
      .asKind('enum')
      .withName(convertSafeName(this.convertName(node.name)))
      .withBlock(indentMultiline(node.values?.map(v => v.name.value).join(',\n'))).string;

    return indentMultiline(enumDefinition, 2);
  }

  public getOperationInterfaceMethods(node: OperationDefinitionNode): string {
    switch (node.operation) {
      case 'query':
      case 'mutation':
        return `${this.getMutationMethodDefinition(node)};`;
      case 'subscription': {
        return `${this.getSubscriptionMethodDefinition(node)};
                ${this.getSubscriptionMethodDefinitionWithHandler(node)};`;
      }
    }
    throw new Error(`Unexpected operation type: ${node.operation}`);
  }

  private variablesObjectName = 'request';
  private clientArgument = this.config.httpClientConfig ? '' : 'IGraphQLClient client, ';
  private httpArguments = 'string authToken = "", Dictionary<string, string> headers = null';

  private getVariablesArguments(node: OperationDefinitionNode): string {
    return node.variableDefinitions?.length
      ? `${this._getVariablesClassName(node)} ${this.variablesObjectName}, `
      : '';
  }
  private getMutationMethodDefinition(node: OperationDefinitionNode): string {
    return `Task<GraphQLResponse<${this._getResponseClassName(node)}>> ${this.convertName(
      node,
    )}Async(
                  ${this.clientArgument}
                  ${this.getVariablesArguments(node)}
                  ${this.config.httpClientConfig ? `${this.httpArguments}, ` : ''}
                  System.Threading.CancellationToken cancellationToken = default
                )`;
  }

  private getSubscriptionMethodDefinition(node: OperationDefinitionNode): string {
    return `IObservable<GraphQLResponse<${this._getResponseClassName(
      node,
    )}>> CreateSubscriptionStream(
                  ${this.clientArgument}
                  ${this.getVariablesArguments(node)}
                  ${this.config.httpClientConfig ? this.httpArguments : ''}
            )`;
  }

  private getSubscriptionMethodDefinitionWithHandler(node: OperationDefinitionNode): string {
    return `IObservable<GraphQLResponse<${this._getResponseClassName(
      node,
    )}>> CreateSubscriptionStream(
                  ${this.clientArgument}
                  ${this.getVariablesArguments(node)}
                  Action<Exception> exceptionHandler
                  ${this.config.httpClientConfig ? `, ${this.httpArguments}` : ''}
            )`;
  }

  public getOperationConcreteMethod(node: OperationDefinitionNode): string {
    const operationSchema = this._schemaAST.definitions.find(
      s => s.kind === Kind.OBJECT_TYPE_DEFINITION && s.name.value.toLowerCase() === node.operation,
    ) as ObjectTypeDefinitionNode;

    if (!operationSchema) {
      throw new Error(`Operation schema not found; ${node.operation}`);
    }

    const inputSignatures = node.variableDefinitions?.map(v => this._gqlInputSignature(v));
    const hasInputArgs = !!inputSignatures?.length;

    let request: string;

    if (this.config.httpClientConfig) {
      request = `
      var gqlRequest = new GraphQLHttpRequestWithHeaders {
          Query = ${this._getDocumentNodeVariable(node)},
          AuthToken = authToken,
          Headers = headers,
          OperationName = "${node.name.value}"${
        hasInputArgs
          ? `,
          Variables = ${this.variablesObjectName}`
          : ''
      }
      };`;
    } else {
      request = `
      var gqlRequest = new GraphQLRequest {
          Query = ${this._getDocumentNodeVariable(node)},
          OperationName = "${node.name.value}"${
        hasInputArgs
          ? `,
          Variables = ${this.variablesObjectName}`
          : ''
      }
      };`;
    }

    switch (node.operation) {
      case 'query':
      case 'mutation':
        return `
          public ${this.getMutationMethodDefinition(node)} {
            ${request}
            return client.Send${operationSchema.name.value}Async<${this._getResponseClassName(
          node,
        )}>(gqlRequest, cancellationToken);
          }
        `;
      case 'subscription': {
        return `
          public ${this.getSubscriptionMethodDefinition(node)} {
            ${request}
            return client.CreateSubscriptionStream<${this._getResponseClassName(node)}>(gqlRequest);
          }

          public ${this.getSubscriptionMethodDefinitionWithHandler(node)} {
            ${request}
            return client.CreateSubscriptionStream<${this._getResponseClassName(
              node,
            )}>(gqlRequest, exceptionHandler);
          }
        `;
      }
    }
    throw new Error(`Unexpected operation type: ${node.operation}`);
  }

  public OperationDefinition(node: OperationDefinitionNode): string {
    if (!node.name || !node.name.value) {
      return null;
    }

    this._collectedOperations.push(node);

    let typesafeOperations = '';
    if (this.config.typesafeOperation) {
      typesafeOperations = `
      ${this.getRequestClass(node)}
      ${this.getResponseClass(node)}
      public partial class ${this.config.operationsClassName} {
        ${this.getOperationConcreteMethod(node)}
      }`;
      typesafeOperations = indentMultiline(typesafeOperations, 3);
    }

    const content = `${typesafeOperations}`;
    return [content].filter(a => a).join('\n');
  }

  public InputObjectTypeDefinition(node: InputObjectTypeDefinitionNode): string {
    if (!this.config.typesafeOperation) {
      return '';
    }

    const inputClass = new CSharpDeclarationBlock()
      .access('public')
      .asKind('class')
      .withName(convertSafeName(this.convertName(node)))
      .withBlock(
        '\n' +
          node.fields
            ?.map(f => {
              if (f.kind !== Kind.INPUT_VALUE_DEFINITION) {
                return null;
              }
              const inputType = this.resolveFieldType(f.type);
              const inputTypeName = wrapFieldType(inputType, inputType.listType, 'List');
              return indentMultiline(
                [
                  `[JsonProperty("${f.name.value}")]`,
                  `public ${inputTypeName} ${convertSafeName(
                    pascalCase(f.name.value),
                  )} { get; set; }`,
                ].join('\n') + '\n',
              );
            })
            .filter(f => !!f)
            .join('\n'),
      ).string;

    return indentMultiline(inputClass, 2);
  }

  public EnumTypeDefinition(node: EnumTypeDefinitionNode): string {
    if (!this.config.typesafeOperation) {
      return '';
    }

    const enumDefinition = new CSharpDeclarationBlock()
      .access('public')
      .asKind('enum')
      .withName(convertSafeName(this.convertName(node.name)))
      .withBlock(indentMultiline(node.values?.map(v => v.name.value).join(',\n'))).string;

    return indentMultiline(enumDefinition, 2);
  }
}
